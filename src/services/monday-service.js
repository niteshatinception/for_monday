const { default: axios } = require('axios');
const initMondayClient = require('monday-sdk-js');

const getColumnValue = async (token, itemId, columnId) => {
  try {
    const mondayClient = initMondayClient();
    mondayClient.setToken(token);
    mondayClient.setApiVersion('2024-01');

    const query = `query($itemId: [ID!], $columnId: [String!]) {
        items (ids: $itemId) {
          column_values(ids:$columnId) {
            value
            text
          }
        }
      }`;
    const variables = { columnId: [columnId], itemId: [itemId] };

    const response = await mondayClient.api(query, { variables });
    if (!response.data?.items?.[0]?.column_values?.[0]) {
      console.log('No value found for column');
      return null;
    }
    return response.data.items[0].column_values[0].value || response.data.items[0].column_values[0].text;
  } catch (err) {
    console.error('Error fetching column value:', err);
    return null;
  }
};

const changeColumnValue = async (token, boardId, itemId, columnId, value) => {
  try {
    const mondayClient = initMondayClient({ token });
    mondayClient.setApiVersion('2024-01');
    console.log(boardId, itemId, columnId, value);
    const query = `mutation change_column_value($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
          id
        }
      }
      `;
    const variables = { boardId, columnId, itemId, value };

    const response = await mondayClient.api(query, { variables });
    return response;
  } catch (err) {
    console.error(err);
  }
};

const getBoardColumns = async (token, boardId) => {
  try {
    const mondayClient = initMondayClient();
    mondayClient.setToken(token);
    mondayClient.setApiVersion('2024-04');

    const query = `query($boardId: ID!) {
        boards(ids: [$boardId]) {
          columns {
            id
            title
            type
          }
        }
      }`;

    const variables = { boardId };

    const response = await mondayClient.api(query, { variables });

    if (!response?.data?.boards?.length) {
      throw new Error(`No data found for boardId: ${boardId}`);
    }

    return response.data.boards[0].columns;
  } catch (err) {
    console.error('❌ Error in getBoardColumns:', err);
    return null;
  }
};

const sendNotification = async ({ accessToken, userId, text, boardId }) => {
  
  const mutation = `
    mutation {
      create_notification(
        user_id: ${userId},
        target_id: ${boardId},
        text: "${text}",
        target_type: Project
      ) {
        text
      }
    }
  `;

  try {
    const response = await axios.post(
      'https://api.monday.com/v2',
      { query: mutation },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken,
        },
      }
    );
  } catch (error) {
    console.error('Error sending notification:', error.response?.data || error.message);
  }
};

const getUpdate = async (token, updateId) => {
  try {
    if (!token || !updateId) throw new Error('Missing token or updateId');

    const query = `
      query {
        updates(ids: [${updateId}]) {
          id
          body  
          creator_id
          created_at
          assets {
            id
            public_url
            name
          }
        }
      }
    `;

    const response = await axios.post(
      'https://api.monday.com/v2',
      { query },
      {
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    if (!response.data || !response.data.data || !response.data.data.updates) {
      console.error('❌ Unexpected API response:', response.data);
      return null;
    }

    return response.data.data.updates[0] || null;
  } catch (err) {
    console.error('❌ Error fetching update:', err);
    return null;
  }
};

module.exports = {
  getColumnValue,
  changeColumnValue,
  getBoardColumns,
  sendNotification,
  getUpdate,
};
