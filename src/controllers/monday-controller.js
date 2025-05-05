const initMondayClient = require('monday-sdk-js');
const mondayService = require('../services/monday-service');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const RetryStrategy = require('../utils/RetryStrategy');
const FileValidator = require('../utils/FileValidator');
const CircuitBreaker = require('../utils/CircuitBreaker');
const MetricsTracker = require('../utils/MetricsTracker');

const retryStrategy = new RetryStrategy();
const circuitBreaker = new CircuitBreaker();
const metricsTracker = new MetricsTracker();

const processingItems = {};
const fileQueues = {};
const processingStatus = {};
const itemRateLimits = {};

const MAX_CONCURRENT_FILES = 5;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30;

function cleanupItem(itemId) {
  if (processingItems[itemId]?.timeoutId) {
    clearTimeout(processingItems[itemId].timeoutId);
  }
  delete processingStatus[itemId];
  delete fileQueues[itemId];
  delete processingItems[itemId];
  delete itemRateLimits[itemId];
}

function checkRateLimit(itemId) {
  const now = Date.now();
  if (!itemRateLimits[itemId]) {
    itemRateLimits[itemId] = {
      requests: [],
      lastReset: now
    };
  }

  // Clean up old requests
  itemRateLimits[itemId].requests = itemRateLimits[itemId].requests.filter(
    time => now - time < RATE_LIMIT_WINDOW
  );

  if (itemRateLimits[itemId].requests.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  itemRateLimits[itemId].requests.push(now);
  return true;
}

function getBackoffDelay(retryCount, errorType) {
  if (errorType === 'complexity') {
    // 8s, 12s, 15s for complexity budget errors
    const baseDelay = 8000;
    const maxDelay = 15000;
    return Math.min(baseDelay + (retryCount * 4000), maxDelay);
  } else {
    // Standard exponential backoff for other errors
    return Math.min(Math.pow(2, retryCount) * 2000, 10000);
  }
}

async function processFileQueue(itemId) {
  if (!fileQueues[itemId] || !Array.isArray(fileQueues[itemId]) || fileQueues[itemId].length === 0) {
    cleanupItem(itemId);
    return;
  }

  if (processingStatus[itemId]) return;
  processingStatus[itemId] = true;

  console.log(`Processing queue for item ${itemId} with ${fileQueues[itemId].length} files remaining`);

  const maxRetries = 3;
  const processedFiles = new Set();
  let concurrentFiles = 0;

  while (fileQueues[itemId] && fileQueues[itemId].length > 0) {
    if (concurrentFiles >= MAX_CONCURRENT_FILES) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    if (!checkRateLimit(itemId)) {
      console.log(`Rate limit reached for item ${itemId}, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }

    const task = fileQueues[itemId][0];

    if (processedFiles.has(task.fileInfo.assetId)) {
      fileQueues[itemId].shift();
      continue;
    }

    concurrentFiles++;

    try {
      // Delay between files to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await processFile(task);

      if (fileQueues[itemId]) {
        fileQueues[itemId].shift();
        processedFiles.add(task.fileInfo.assetId);
        if (processingItems[itemId]) {
          processingItems[itemId].processedCount = (processingItems[itemId].processedCount || 0) + 1;
        }
      }
    } catch (err) {
      console.error(`Failed to process file ${task.fileInfo.name}:`, err);

      if (!fileQueues[itemId]) {
        concurrentFiles--;
        continue;
      }

      task.retryCount = (task.retryCount || 0) + 1;
      const isComplexityError = err.message.includes('Complexity budget exhausted');
      const isAuthError = err.message.includes('not authenticated');

      if (task.retryCount < maxRetries && !isAuthError && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.message.includes('Failed to get public URL') || isComplexityError)) {
        console.log(`Retrying file ${task.fileInfo.name} (attempt ${task.retryCount + 1}/${maxRetries})`);
        const backoffDelay = getBackoffDelay(task.retryCount, isComplexityError ? 'complexity' : 'standard');
        console.log(`Waiting ${backoffDelay/1000} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      } else {
        console.error(`Max retries reached or permanent error for file ${task.fileInfo.name}: ${err.message}`);
        if (fileQueues[itemId] && fileQueues[itemId].length > 0) {
          fileQueues[itemId].shift();
          processedFiles.add(task.fileInfo.assetId);
        }
      }
    } finally {
      concurrentFiles--;
    }
  }

  try {
    const completedFilesCount = processingItems[itemId]?.processedCount || 0;
    const endTime = Date.now();
    const processingTimeInSeconds = ((endTime - (processingItems[itemId]?.startTime || endTime)) / 1000).toFixed(2);

    console.log(`📊 Processing summary for item ${itemId}:`);
    console.log(`✅ Files processed successfully: ${completedFilesCount}`);
    console.log(`⏱️ Total processing time: ${processingTimeInSeconds} seconds`);

    // Clear token cache when done
    TokenService.clearToken(itemId);
    cleanupItem(itemId);
  } catch (err) {
    console.error(`Error during cleanup for item ${itemId}:`, err);
    cleanupItem(itemId);
  }
}

const TokenService = require('../services/token-service');

async function processFile({ token, itemId, destinationColumnId, fileInfo, tempDir }) {
  const startTime = Date.now();
  const context = { itemId, fileName: fileInfo.name };

  try {
    return await circuitBreaker.execute(`file:${itemId}`, async () => {
      return await retryStrategy.execute(async () => {
        // Get fresh token before processing
        token = await TokenService.getToken(itemId, token);
        let tempFilePath = null;
        try {
          console.log(`Processing file: ${fileInfo.name} for item ${itemId}`);

          const mondayClient = initMondayClient();
          mondayClient.setToken(token);

          const assetQuery = `query {
            assets(ids: [${fileInfo.assetId}]) {
              public_url
            }
          }`;

          console.log(`Fetching public URL for asset ${fileInfo.assetId}...`);
          const assetResponse = await mondayClient.api(assetQuery);
          
          console.log('Asset Response:', JSON.stringify(assetResponse, null, 2));
          
          if (!assetResponse?.data?.assets?.[0]?.public_url) {
            const errorMsg = assetResponse.errors 
              ? `Failed to get public URL: ${JSON.stringify(assetResponse.errors)}`
              : 'Failed to get public URL: No URL returned';
            console.error(errorMsg);
            throw new Error(errorMsg);
          }

          const publicUrl = assetResponse.data.assets[0].public_url;
          console.log(`Successfully fetched public URL for ${fileInfo.name}: ${publicUrl}`);

          // Validate URL before downloading
          const validation = await FileValidator.validatePublicUrl(publicUrl, fileInfo.name);
          if (!validation.isValid) {
            throw new Error(`Invalid file type: ${validation.contentType || 'unknown'}`);
          }

          const response = await fetch(publicUrl);
          if (!response.ok) {
            throw new Error(`Failed to download file: ${response.statusText}`);
          }

          const fileBlob = await response.buffer();
          tempFilePath = path.join(tempDir, fileInfo.name);
          await fs.promises.writeFile(tempFilePath, fileBlob);

          const form = new FormData();
          const query = `mutation($file: File!) {
            add_file_to_column (
              item_id: ${itemId},
              column_id: "${destinationColumnId}",
              file: $file
            ) {
              id
            }
          }`;

          form.append('query', query);
          form.append('variables[file]', fs.createReadStream(tempFilePath));

          const uploadResponse = await fetch('https://api.monday.com/v2/file', {
            method: 'POST',
            headers: {
              Authorization: token,
              ...form.getHeaders(),
              'Transfer-Encoding': 'chunked',
            },
            body: form,
            timeout: 60000,
          });

          const responseData = await uploadResponse.json();

          if (!uploadResponse.ok || responseData.errors) {
            const errorMsg = responseData.errors ? responseData.errors[0].message : uploadResponse.statusText;
            throw new Error(`Upload failed: ${errorMsg}`);
          }

          console.log(`Successfully processed file: ${fileInfo.name} for item ${itemId}`);
          metricsTracker.track('file_processing', 'success', {
            success: true,
            duration: Date.now() - startTime,
            fileType: path.extname(fileInfo.name)
          });

          return responseData;
        } catch (error) {
          metricsTracker.track('file_processing', 'failure', {
            failure: true,
            duration: Date.now() - startTime,
            error: error.message
          });
          throw error;
        } finally {
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
            } catch (err) {
              console.error(`Failed to clean up temp file ${tempFilePath}:`, err);
            }
          }
        }
      });
    });
  } catch (err) {
    metricsTracker.track('file_processing', 'failure', {
      failure: true,
      duration: Date.now() - startTime,
      error: err.message
    });
    throw err;
  }
}

async function copyFileFromColumnToColumn(req, res) {
  const { shortLivedToken } = req.session;
  const { payload } = req.body;

  try {
    const { inputFields } = payload;
    const { boardId, itemId, sourceColumnId, destinationColumnId } = inputFields;

    if (!boardId || !itemId || !sourceColumnId || !destinationColumnId) {
      console.error('Missing required parameters:', { boardId, itemId, sourceColumnId, destinationColumnId });
      return res.status(400).send({
        message: 'Missing required parameters',
        required: ['boardId', 'itemId', 'sourceColumnId', 'destinationColumnId'],
      });
    }

    if (processingItems[itemId]) {
      console.log(`Already processing item ${itemId}, skipping duplicate request.`);
      return res.status(200).send({ success: true, message: 'Already processing' });
    }

    processingItems[itemId] = {
      timeoutId: setTimeout(() => {
        console.warn(`Auto-releasing lock for item ${itemId} after timeout.`);
        cleanupItem(itemId);
      }, 3000000), // 50 minutes
      startTime: Date.now(),
      processedCount: 0,
    };

    const fileValue = await mondayService.getColumnValue(shortLivedToken, itemId, sourceColumnId);
    if (!fileValue) {
      console.log(`No value found in source column ${sourceColumnId}`);
      cleanupItem(itemId);
      return res.status(200).send({});
    }

    let sourceFileData;
    try {
      sourceFileData = JSON.parse(fileValue);
    } catch (err) {
      console.error('Failed to parse file data:', fileValue);
      cleanupItem(itemId);
      return res.status(400).send({ message: 'Invalid file data format' });
    }

    if (!sourceFileData || !sourceFileData.files || !Array.isArray(sourceFileData.files)) {
      cleanupItem(itemId);
      return res.status(400).send({ message: 'Invalid file data structure' });
    }

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fileQueues[itemId] = sourceFileData.files
      .filter(fileInfo => fileInfo.assetId)
      .map(fileInfo => ({
        token: shortLivedToken,
        itemId,
        destinationColumnId,
        fileInfo,
        tempDir,
        retryCount: 0
      }));

    // Start processing the queue for this item
    processFileQueue(itemId);

    return res.status(200).send({
      success: true,
      message: `Queued ${fileQueues[itemId]?.length || 0} files for processing`
    });
  } catch (err) {
    console.error('Main error:', err);
    cleanupItem(itemId);
    return res.status(500).send({ message: 'Internal server error' });
  }
}

module.exports = {
  copyFileFromColumnToColumn,
};