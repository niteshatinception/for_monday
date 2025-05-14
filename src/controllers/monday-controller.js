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
const { SecureStorage } = require('@mondaycom/apps-sdk');
const jwt = require('jsonwebtoken');
const TokenService = require('../services/token-service');
const { default: PQueue } = require('p-queue');
const { OPERATION_TYPES } = require('../constant/copyMove');

const queue = new PQueue({ concurrency: 5, intervalCap: 20, interval: 1000 });

const secureStorage = new SecureStorage(process.env.MONDAY_API_TOKEN);
const retryStrategy = new RetryStrategy();
const circuitBreaker = new CircuitBreaker();
const metricsTracker = new MetricsTracker();

const processingItems = {};
const fileQueues = {};
const processingStatus = {};
const itemRateLimits = {};

const MAX_CONCURRENT_FILES = 3;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20;

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
      lastReset: now,
    };
  }

  // Clean up old requests
  itemRateLimits[itemId].requests = itemRateLimits[itemId].requests.filter((time) => now - time < RATE_LIMIT_WINDOW);

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
    return Math.min(baseDelay + retryCount * 4000, maxDelay);
  } else {
    // Standard exponential backoff for other errors
    return Math.min(Math.pow(2, retryCount) * 2000, 10000);
  }
}

const getFileColumnsFromBoard = async (req, res) => {
  const { shortLivedToken } = req.session;
  const { payload } = req.body;
  const decoded = jwt.decode(shortLivedToken);
  const userId = decoded.uid;
  const accessToken = await secureStorage.get(userId);
  try {
    const boardId = payload.destinationBoardId;

    // Fetch all columns from Monday board
    const columns = await mondayService.getBoardColumns(accessToken, boardId);

    // Filter only file-type columns
    const fileColumns = columns.filter((column) => column.type === 'file');

    // Pagination
    const { pageRequestData } = payload;
    const { page = 1 } = pageRequestData || {};
    const pageSize = 5;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    const paginatedColumns = fileColumns.slice(startIndex, endIndex);
    const isLastPage = endIndex >= fileColumns.length;

    // Send response in expected format
    res.status(200).json({
      options: paginatedColumns.map((col) => ({
        title: col.title,
        value: col.id,
      })),
      isPaginated: true,
      nextPageRequestData: isLastPage ? null : { page: page + 1 },
      isLastPage: isLastPage,
    });
  } catch (err) {
    console.error('❌ Error fetching board columns:', err);
    res.status(500).json({ error: 'Failed to fetch file columns' });
  }
};

async function processFileQueue(itemId) {
  if (!fileQueues[itemId] || !Array.isArray(fileQueues[itemId]) || fileQueues[itemId].length === 0) {
    cleanupItem(itemId);
    return;
  }

  if (processingStatus[itemId]) return;
  processingStatus[itemId] = true;

  console.log(`Processing queue for item ${itemId} with ${fileQueues[itemId].length} files remaining`);

  const maxRetries = 10;
  const processedFiles = new Set();
  let concurrentFiles = 0;

  while (fileQueues[itemId] && fileQueues[itemId].length > 0) {
    if (concurrentFiles >= MAX_CONCURRENT_FILES) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (!checkRateLimit(itemId)) {
      console.log(`Rate limit reached for item ${itemId}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
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

      if (
        task.retryCount < maxRetries &&
        !isAuthError &&
        (err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNRESET' ||
          err.message.includes('Failed to get public URL') ||
          isComplexityError)
      ) {
        console.log(`Retrying file ${task.fileInfo.name} (attempt ${task.retryCount + 1}/${maxRetries})`);
        const backoffDelay = getBackoffDelay(task.retryCount, isComplexityError ? 'complexity' : 'standard');
        console.log(`Waiting ${backoffDelay / 1000} seconds before retry...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
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

async function processFileQueueItem(itemId) {
  if (!fileQueues[itemId] || !Array.isArray(fileQueues[itemId]) || fileQueues[itemId].length === 0) {
    cleanupItem(itemId);
    return;
  }

  if (processingStatus[itemId]) return;
  processingStatus[itemId] = true;

  console.log(`Processing queue for item ${itemId} with ${fileQueues[itemId].length} files remaining`);

  const maxRetries = 10;
  const processedFiles = new Set();
  let concurrentFiles = 0;

  while (fileQueues[itemId] && fileQueues[itemId].length > 0) {
    if (concurrentFiles >= MAX_CONCURRENT_FILES) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (!checkRateLimit(itemId)) {
      console.log(`Rate limit reached for item ${itemId}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      await processFileItem(task);

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

      if (
        task.retryCount < maxRetries &&
        !isAuthError &&
        (err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNRESET' ||
          err.message.includes('Failed to get public URL') ||
          isComplexityError)
      ) {
        console.log(`Retrying file ${task.fileInfo.name} (attempt ${task.retryCount + 1}/${maxRetries})`);
        const backoffDelay = getBackoffDelay(task.retryCount, isComplexityError ? 'complexity' : 'standard');
        console.log(`Waiting ${backoffDelay / 1000} seconds before retry...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
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

async function processFileQueueBoard(itemId) {
  if (!fileQueues[itemId] || !Array.isArray(fileQueues[itemId]) || fileQueues[itemId].length === 0) {
    cleanupItem(itemId);
    return;
  }

  if (processingStatus[itemId]) return;
  processingStatus[itemId] = true;

  console.log(`Processing queue for item ${itemId} with ${fileQueues[itemId].length} files remaining`);

  const maxRetries = 10;
  const processedFiles = new Set();
  let concurrentFiles = 0;

  while (fileQueues[itemId] && fileQueues[itemId].length > 0) {
    if (concurrentFiles >= MAX_CONCURRENT_FILES) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (!checkRateLimit(itemId)) {
      console.log(`Rate limit reached for item ${itemId}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      await processFileBoard(task);

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

      if (
        task.retryCount < maxRetries &&
        !isAuthError &&
        (err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNRESET' ||
          err.message.includes('Failed to get public URL') ||
          isComplexityError)
      ) {
        console.log(`Retrying file ${task.fileInfo.name} (attempt ${task.retryCount + 1}/${maxRetries})`);
        const backoffDelay = getBackoffDelay(task.retryCount, isComplexityError ? 'complexity' : 'standard');
        console.log(`Waiting ${backoffDelay / 1000} seconds before retry...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
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

async function processFile({
  accessToken,
  itemId,
  destinationColumnId,
  fileInfo,
  tempDir,
  userId,
  boardId,
  sourceColumnId,
}) {
  const startTime = Date.now();

  try {
    return await circuitBreaker.execute(`file:${itemId}`, async () => {
      return await retryStrategy.execute(async () => {
        // Get fresh token before processing
        // token = await TokenService.getToken(itemId, token);
        let tempFilePath = null;
        try {
          console.log(`Processing file: ${fileInfo.name} for item ${itemId}`);

          const mondayClient = initMondayClient();
          mondayClient.setToken(accessToken);

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
              Authorization: accessToken,
              ...form.getHeaders(),
              'Transfer-Encoding': 'chunked',
            },
            body: form,
            timeout: 60000,
          });

          const responseData = await uploadResponse.json();

          if (!uploadResponse.ok || responseData.errors) {
            const errorMsg = responseData.errors ? responseData.errors[0].message : uploadResponse.statusText;
            if (errorMsg === 'Value exceeded max value for column') {
              const text = 'Value exceeded max value for column';
              await mondayService.sendNotification({ accessToken, userId, text, boardId });
              return;
            }
            throw new Error(`Upload failed: ${errorMsg}`);
          }

          console.log(`Successfully processed file: ${fileInfo.name} for item ${itemId}`);
          metricsTracker.track('file_processing', 'success', {
            success: true,
            duration: Date.now() - startTime,
            fileType: path.extname(fileInfo.name),
          });

          return responseData;
        } catch (error) {
          metricsTracker.track('file_processing', 'failure', {
            failure: true,
            duration: Date.now() - startTime,
            error: error.message,
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
      error: err.message,
    });
    throw err;
  }
}

async function processFileItem({ accessToken, targetItemId, fileColumnId, fileInfo, tempDir, userId, boardId }) {
  const startTime = Date.now();
  try {
    return await circuitBreaker.execute(`file:${targetItemId}`, async () => {
      return await retryStrategy.execute(async () => {
        // Get fresh token before processing
        // token = await TokenService.getToken(targetItemId, token);
        let tempFilePath = null;
        try {
          console.log(`Processing file: ${fileInfo.name} for item ${targetItemId}`);

          const mondayClient = initMondayClient();
          mondayClient.setToken(accessToken);

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
              item_id: ${targetItemId},
              column_id: "${fileColumnId}",
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
              Authorization: accessToken,
              ...form.getHeaders(),
              'Transfer-Encoding': 'chunked',
            },
            body: form,
            timeout: 60000,
          });

          const responseData = await uploadResponse.json();

          if (!uploadResponse.ok || responseData.errors) {
            const errorMsg = responseData.errors ? responseData.errors[0].message : uploadResponse.statusText;
            if (errorMsg === 'Value exceeded max value for column') {
              const text = 'Value exceeded max value for column';
              await mondayService.sendNotification({ accessToken, userId, text, boardId });
              return;
            }

            throw new Error(`Upload failed: ${errorMsg}`);
          }

          console.log(`Successfully processed file: ${fileInfo.name} for item ${targetItemId}`);
          metricsTracker.track('file_processing', 'success', {
            success: true,
            duration: Date.now() - startTime,
            fileType: path.extname(fileInfo.name),
          });

          return responseData;
        } catch (error) {
          metricsTracker.track('file_processing', 'failure', {
            failure: true,
            duration: Date.now() - startTime,
            error: error.message,
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
      error: err.message,
    });
    throw err;
  }
}

async function processFileBoard({
  accessToken,
  destinationBoardId,
  destinationFileColumnIds,
  connectedBoardColumnId,
  sourceItemId,
  fileInfo,
  tempDir,
  userId,
}) {
  const startTime = Date.now();
  const boardId = destinationBoardId;
  try {
    return await circuitBreaker.execute(`file:${destinationFileColumnIds?.value}`, async () => {
      return await retryStrategy.execute(async () => {
        // Get fresh token before processing
        // token = await TokenService.getToken(targetItemId, token);
        let tempFilePath = null;
        try {
          console.log(`Processing file: ${fileInfo.name} for item ${destinationFileColumnIds?.value}`);

          const mondayClient = initMondayClient();
          mondayClient.setToken(accessToken);

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

          const connectedItemData = await mondayService.getColumnValue(
            accessToken,
            sourceItemId,
            connectedBoardColumnId
          );
          let destinationItems = [];
          if (connectedItemData) {
            try {
              const parsedData = JSON.parse(connectedItemData);
              if (parsedData?.linkedPulseIds?.length > 0) {
                destinationItems = parsedData.linkedPulseIds.map((link) => ({
                  itemId: link.linkedPulseId,
                  boardId: link.boardId || destinationBoardId,
                }));
              }
            } catch (parseError) {
              console.error('Error parsing connectedItemData:', parseError);
            }
          }

          if (destinationItems.length === 0) {
            console.log('❌ No connected items found.');
            return res.status(400).send({ message: 'No linked items found in the connected board column.' });
          }

          console.log(`Found ${destinationItems.length} connected items:`, destinationItems);

          const form = new FormData();
          const query = `mutation($file: File!) {
              add_file_to_column (
                item_id: ${destinationItems[0].itemId},
                column_id: "${destinationFileColumnIds?.value}",
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
              Authorization: accessToken,
              ...form.getHeaders(),
              'Transfer-Encoding': 'chunked',
            },
            body: form,
            timeout: 60000,
          });

          const responseData = await uploadResponse.json();

          if (!uploadResponse.ok || responseData.errors) {
            const errorMsg = responseData.errors ? responseData.errors[0].message : uploadResponse.statusText;
            if (errorMsg === 'Value exceeded max value for column') {
              const text = 'Value exceeded max value for column';
              await mondayService.sendNotification({ accessToken, userId, text, boardId });
              return;
            }
            console.error(`❌ Upload failed for item ${destinationItems[0].itemId}:`, errorMsg);
          }

          console.log(`✅ Successfully processed file: ${fileInfo.name} for item ${destinationItems[0].itemId}`);

          metricsTracker.track('file_processing', 'success', {
            success: true,
            duration: Date.now() - startTime,
            fileType: path.extname(fileInfo.name),
            itemId: destinationItems[0].itemId,
          });

          return responseData;
        } catch (error) {
          metricsTracker.track('file_processing', 'failure', {
            failure: true,
            duration: Date.now() - startTime,
            error: error.message,
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
      error: err.message,
    });
    throw err;
  }
}

async function copyFileFromColumnToColumn(req, res) {
  await queue.add(async () => {
    try {
      await handleTask(req, res);
    } catch (err) {
      console.error('Error handling task:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

async function handleTask(req, res) {
  const { shortLivedToken } = req.session;
  const { payload } = req.body;
  const decoded = jwt.decode(shortLivedToken);
  const userId = decoded.uid;
  const accessToken = await secureStorage.get(userId);

  try {
    if (!payload?.inputFields?.itemId) {
      return res.status(400).send({ message: 'Missing itemId in payload' });
    }

    const { inputFields } = payload;
    const { boardId, itemId, sourceColumnId, destinationColumnId, selectCopyMove } = inputFields;

    if (!accessToken) {
      return res.status(401).send({ message: 'No valid token available' });
    }

    const actionValue =
      typeof selectCopyMove === 'object' && selectCopyMove?.value ? selectCopyMove.value : selectCopyMove;

    if (!['COPY', 'MOVE'].includes(actionValue)) {
      console.error(`Invalid selectCopyMove value: ${actionValue}`);
      return res.status(400).send({ message: 'Invalid action specified' });
    }

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
    const fileValue = await mondayService.getColumnValue(accessToken, itemId, sourceColumnId);
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
      .filter((fileInfo) => fileInfo.assetId)
      .map((fileInfo) => ({
        accessToken: accessToken,
        itemId: itemId,
        destinationColumnId,
        fileInfo,
        tempDir,
        userId,
        boardId,
        sourceColumnId,
      }));

    // Start processing the queue for this item
    processFileQueue(itemId);

    if (actionValue === 'MOVE') {
      // Wait for file processing to complete
      while (processingItems[itemId]) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Clear the source column
      try {
        await mondayService.changeColumnValue(accessToken, boardId, itemId, sourceColumnId, JSON.stringify({}));
        console.log(`Cleared source column ${sourceColumnId} for item ${itemId}`);
      } catch (err) {
        console.error('Error clearing source column:', err);
      }
    }

    return res.status(200).send({
      success: true,
      message: `Queued ${fileQueues[itemId]?.length || 0} files for processing`,
    });
  } catch (err) {
    console.error('Main error:', err);
    const itemIdToCleanup = payload?.inputFields?.itemId;
    if (itemIdToCleanup) {
      cleanupItem(itemIdToCleanup);
    }
    return res.status(500).send({ message: 'Internal server error' });
  }
}

async function copyFileFromItemToItem(req, res) {
  await queue.add(async () => {
    try {
      await handleTaskItem(req, res);
    } catch (err) {
      console.error('Error handling task:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

async function handleTaskItem(req, res) {
  const { shortLivedToken } = req.session;
  const { payload } = req.body;

  const decoded = jwt.decode(shortLivedToken);
  const userId = decoded.uid;
  const accessToken = await secureStorage.get(userId);

  try {
    if (!payload?.inputFields?.sourceItemId) {
      return res.status(400).send({ message: 'Missing itemId in payload' });
    }

    const { inputFields } = payload;
    const { boardId, sourceItemId, targetItemId, fileColumnId, selectCopyMove } = inputFields;
    const actionValue =
      typeof selectCopyMove === 'object' && selectCopyMove?.value ? selectCopyMove.value : selectCopyMove;

    if (!['COPY', 'MOVE'].includes(actionValue)) {
      console.error(`Invalid selectCopyMove value: ${actionValue}`);
      return res.status(400).send({ message: 'Invalid action specified' });
    }
    if (!accessToken) {
      return res.status(401).send({ message: 'No valid token available' });
    }

    if (!boardId || !sourceItemId || !targetItemId || !fileColumnId || !selectCopyMove) {
      console.error('Missing required parameters:', {
        boardId,
        sourceItemId,
        targetItemId,
        fileColumnId,
        selectCopyMove,
      });
      return res.status(400).send({
        message: 'Missing required parameters',
        required: ['boardId', 'sourceItemId', 'targetItemId', 'fileColumnId', 'selectCopyMove'],
      });
    }

    if (processingItems[sourceItemId]) {
      console.log(`Already processing item ${sourceItemId}, skipping duplicate request.`);
      return res.status(200).send({ success: true, message: 'Already processing' });
    }

    processingItems[sourceItemId] = {
      timeoutId: setTimeout(() => {
        console.warn(`Auto-releasing lock for item ${sourceItemId} after timeout.`);
        cleanupItem(sourceItemId);
      }, 3000000), // 50 minutes
      startTime: Date.now(),
      processedCount: 0,
    };
    const fileValue = await mondayService.getColumnValue(accessToken, sourceItemId, fileColumnId);

    if (!fileValue) {
      console.log(`No value found in source column ${fileColumnId}`);
      cleanupItem(sourceItemId);
      return res.status(200).send({});
    }

    let sourceFileData;
    try {
      sourceFileData = JSON.parse(fileValue);
    } catch (err) {
      console.error('Failed to parse file data:', fileValue);
      cleanupItem(sourceItemId);
      return res.status(400).send({ message: 'Invalid file data format' });
    }

    if (!sourceFileData || !sourceFileData.files || !Array.isArray(sourceFileData.files)) {
      cleanupItem(sourceItemId);
      return res.status(400).send({ message: 'Invalid file data structure' });
    }

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fileQueues[sourceItemId] = sourceFileData.files
      .filter((fileInfo) => fileInfo.assetId)
      .map((fileInfo) => ({
        accessToken,
        sourceItemId,
        targetItemId,
        fileColumnId,
        fileInfo,
        tempDir,
        userId,
        boardId,
      }));

    // Start processing the queue for this item
    processFileQueueItem(sourceItemId);

    if (actionValue === 'MOVE') {
      // Wait for file processing to complete
      while (processingItems[sourceItemId]) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Clear the source column
      try {
        await mondayService.changeColumnValue(accessToken, boardId, sourceItemId, fileColumnId, JSON.stringify({}));
        console.log(`Cleared source Item ${sourceItemId} `);
      } catch (err) {
        console.error('Error clearing source column:', err);
      }
    }

    return res.status(200).send({
      success: true,
      message: `Queued ${fileQueues[sourceItemId]?.length || 0} files for processing`,
    });
  } catch (err) {
    console.error('Main error:', err);
    const itemIdToCleanup = payload?.inputFields?.sourceItemId;
    if (itemIdToCleanup) {
      cleanupItem(itemIdToCleanup);
    }
    return res.status(500).send({ message: 'Internal server error' });
  }
}

async function copyFileFromBoardToBoard(req, res) {
  await queue.add(async () => {
    try {
      await handleTaskBoard(req, res);
    } catch (err) {
      console.error('Error handling task:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

async function handleTaskBoard(req, res) {
  const { shortLivedToken } = req.session;
  const { payload } = req.body;

  const decoded = jwt.decode(shortLivedToken);
  const userId = decoded.uid;
  const accessToken = await secureStorage.get(userId);

  try {
    if (!payload?.inputFields?.sourceItemId) {
      return res.status(400).send({ message: 'Missing itemId in payload' });
    }

    const { inputFields } = payload;
    const {
      sourceBoardId,
      sourceFileColumnId,
      destinationBoardId,
      destinationFileColumnIds,
      connectedBoardColumnId,
      sourceItemId,
      selectCopyMove,
    } = inputFields;

    if (!accessToken) {
      return res.status(401).send({ message: 'No valid token available' });
    }

    const actionValue =
    typeof selectCopyMove === 'object' && selectCopyMove?.value ? selectCopyMove.value : selectCopyMove;

  if (!['COPY', 'MOVE'].includes(actionValue)) {
    console.error(`Invalid selectCopyMove value: ${actionValue}`);
    return res.status(400).send({ message: 'Invalid action specified' });
  }

    if (
      !sourceBoardId ||
      !sourceFileColumnId ||
      !destinationBoardId ||
      !destinationFileColumnIds ||
      !connectedBoardColumnId ||
      !sourceItemId ||
      !selectCopyMove
    ) {
      console.error('Missing required parameters:', {
        sourceBoardId,
        sourceFileColumnId,
        destinationBoardId,
        destinationFileColumnIds,
        connectedBoardColumnId,
        sourceItemId,
        selectCopyMove,
      });
      return res.status(400).send({
        message: 'Missing required parameters',
        required: [
          'sourceBoardId',
          'sourceFileColumnId',
          'destinationBoardId',
          'destinationFileColumnIds',
          'connectedBoardColumnId',
          'sourceItemId',
          'selectCopyMove',
        ],
      });
    }

    if (processingItems[sourceItemId]) {
      console.log(`Already processing item ${sourceItemId}, skipping duplicate request.`);
      return res.status(200).send({ success: true, message: 'Already processing' });
    }

    processingItems[sourceItemId] = {
      timeoutId: setTimeout(() => {
        console.warn(`Auto-releasing lock for item ${sourceItemId} after timeout.`);
        cleanupItem(sourceItemId);
      }, 3000000), // 50 minutes
      startTime: Date.now(),
      processedCount: 0,
    };
    const fileValue = await mondayService.getColumnValue(accessToken, sourceItemId, sourceFileColumnId);

    if (!fileValue) {
      console.log(`No value found in source column ${sourceFileColumnId}`);
      cleanupItem(sourceItemId);
      return res.status(200).send({});
    }

    let sourceFileData;
    try {
      sourceFileData = JSON.parse(fileValue);
    } catch (err) {
      console.error('Failed to parse file data:', fileValue);
      cleanupItem(sourceItemId);
      return res.status(400).send({ message: 'Invalid file data format' });
    }

    if (!sourceFileData || !sourceFileData.files || !Array.isArray(sourceFileData.files)) {
      cleanupItem(sourceItemId);
      return res.status(400).send({ message: 'Invalid file data structure' });
    }

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fileQueues[sourceItemId] = sourceFileData.files
      .filter((fileInfo) => fileInfo.assetId)
      .map((fileInfo) => ({
        accessToken: accessToken,
        destinationBoardId,
        destinationFileColumnIds,
        connectedBoardColumnId,
        sourceItemId,
        fileInfo,
        tempDir,
        userId,
      }));

    // Start processing the queue for this item
    processFileQueueBoard(sourceItemId);

    if (actionValue === 'MOVE') {
      // Wait for file processing to complete
      while (processingItems[sourceItemId]) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Clear the source column
      try {
        await mondayService.changeColumnValue(accessToken, sourceBoardId, sourceItemId, sourceFileColumnId, JSON.stringify({}));
        console.log(`Cleared source column ${sourceItemId}`);
      } catch (err) {
        console.error('Error clearing source column:', err);
      }
    }


    return res.status(200).send({
      success: true,
      message: `Queued ${fileQueues[sourceItemId]?.length || 0} files for processing`,
    });
  } catch (err) {
    console.error('Main error:', err);
    const itemIdToCleanup = payload?.inputFields?.sourceItemId;
    if (itemIdToCleanup) {
      cleanupItem(itemIdToCleanup);
    }
    return res.status(500).send({ message: 'Internal server error' });
  }
}

const handleGetRemoteListOptions = (req, res) => {
  try {
    return res.status(200).send(OPERATION_TYPES);
  } catch (err) {
    console.error(err);
    return res.status(500).send({ message: 'internal server error' });
  }
};

async function processFileUpdate({ accessToken, itemId, fileColumnId, fileInfo, tempDir, userId, boardId }) {
  const startTime = Date.now();

  try {
    return await circuitBreaker.execute(`file:${itemId}`, async () => {
      return await retryStrategy.execute(async () => {
        // Get fresh token before processing
        // token = await TokenService.getToken(itemId, token);
        let tempFilePath = null;
        try {
          console.log(`Processing file: ${fileInfo.name} for item ${itemId}`);

          const mondayClient = initMondayClient();
          mondayClient.setToken(accessToken);

          const publicUrl = fileInfo.public_url;
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
              column_id: "${fileColumnId}",
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
              Authorization: accessToken,
              ...form.getHeaders(),
              'Transfer-Encoding': 'chunked',
            },
            body: form,
            timeout: 60000,
          });

          const responseData = await uploadResponse.json();

          if (!uploadResponse.ok || responseData.errors) {
            const errorMsg = responseData.errors ? responseData.errors[0].message : uploadResponse.statusText;
            if (errorMsg === 'Value exceeded max value for column') {
              const text = 'Value exceeded max value for column';
              await mondayService.sendNotification({ accessToken, userId, text, boardId });
              return;
            }
            throw new Error(`Upload failed: ${errorMsg}`);
          }

          console.log(`Successfully processed file: ${fileInfo.name} for item ${itemId}`);
          metricsTracker.track('file_processing', 'success', {
            success: true,
            duration: Date.now() - startTime,
            fileType: path.extname(fileInfo.name),
          });

          return responseData;
        } catch (error) {
          metricsTracker.track('file_processing', 'failure', {
            failure: true,
            duration: Date.now() - startTime,
            error: error.message,
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
      error: err.message,
    });
    throw err;
  }
}

async function processFileQueueUpdate(itemId) {
  if (!fileQueues[itemId] || !Array.isArray(fileQueues[itemId]) || fileQueues[itemId].length === 0) {
    cleanupItem(itemId);
    return;
  }

  if (processingStatus[itemId]) return;
  processingStatus[itemId] = true;

  console.log(`Processing queue for item ${itemId} with ${fileQueues[itemId].length} files remaining`);

  const maxRetries = 10;
  const processedFiles = new Set();
  let concurrentFiles = 0;

  while (fileQueues[itemId] && fileQueues[itemId].length > 0) {
    if (concurrentFiles >= MAX_CONCURRENT_FILES) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (!checkRateLimit(itemId)) {
      console.log(`Rate limit reached for item ${itemId}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    const task = fileQueues[itemId][0];

    if (processedFiles.has(task.fileInfo.id)) {
      fileQueues[itemId].shift();
      continue;
    }

    concurrentFiles++;

    try {
      // Delay between files to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await processFileUpdate(task);

      if (fileQueues[itemId]) {
        fileQueues[itemId].shift();
        processedFiles.add(task.fileInfo.id);
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

      if (
        task.retryCount < maxRetries &&
        !isAuthError &&
        (err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNRESET' ||
          err.message.includes('Failed to get public URL') ||
          isComplexityError)
      ) {
        console.log(`Retrying file ${task.fileInfo.name} (attempt ${task.retryCount + 1}/${maxRetries})`);
        const backoffDelay = getBackoffDelay(task.retryCount, isComplexityError ? 'complexity' : 'standard');
        console.log(`Waiting ${backoffDelay / 1000} seconds before retry...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
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

async function copyFileFromUpdateToItem(req, res) {
  await queue.add(async () => {
    try {
      await handleTaskUpdate(req, res);
    } catch (err) {
      console.error('Error handling task:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

async function handleTaskUpdate(req, res) {
  const { shortLivedToken } = req.session;
  const { payload } = req.body;

  const decoded = jwt.decode(shortLivedToken);
  const userId = decoded.uid;
  const accessToken = await secureStorage.get(userId);

  try {
    if (!payload?.inputFields?.itemId) {
      return res.status(400).send({ message: 'Missing itemId in payload' });
    }

    const { inputFields } = payload;
    const { boardId, itemId, fileColumnId, updateId } = inputFields;

    if (!accessToken) {
      return res.status(401).send({ message: 'No valid token available' });
    }

    if (!boardId || !itemId || !fileColumnId || !updateId) {
      console.error('Missing required parameters:', { boardId, itemId, fileColumnId, updateId });
      return res.status(400).send({
        message: 'Missing required parameters',
        required: ['boardId', 'itemId', 'fileColumnId', 'updateId'],
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

    const updateData = await mondayService.getUpdate(accessToken, updateId);

    if (!updateData || !updateData.assets || updateData.assets.length === 0) {
      console.log('❌ No files found in update.');
      return res.status(200).send({ message: 'No files found to copy.' });
    }

    console.log('📂 Files Found in Update:', updateData.assets);

    if (!updateData) {
      console.log(`No value found in update ${updateId}`);
      cleanupItem(itemId);
      return res.status(200).send({});
    }

    let sourceFileData = updateData.assets;

    if (!sourceFileData || !Array.isArray(sourceFileData)) {
      cleanupItem(itemId);
      return res.status(400).send({ message: 'Invalid file data structure' });
    }

    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fileQueues[itemId] = sourceFileData
      .filter((fileInfo) => fileInfo.id)
      .map((fileInfo) => ({
        accessToken,
        itemId,
        fileColumnId,
        fileInfo,
        tempDir,
        userId,
        boardId,
      }));

    // Start processing the queue for this item
    processFileQueueUpdate(itemId);

    return res.status(200).send({
      success: true,
      message: `Queued ${fileQueues[itemId]?.length || 0} files for processing`,
    });
  } catch (err) {
    console.error('Main error:', err);
    const itemIdToCleanup = payload?.inputFields?.itemId;
    if (itemIdToCleanup) {
      cleanupItem(itemIdToCleanup);
    }
    return res.status(500).send({ message: 'Internal server error' });
  }
}

module.exports = {
  copyFileFromColumnToColumn,
  copyFileFromItemToItem,
  copyFileFromBoardToBoard,
  getFileColumnsFromBoard,
  handleGetRemoteListOptions,
  copyFileFromUpdateToItem,
};
