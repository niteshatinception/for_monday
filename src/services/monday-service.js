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
    mondayClient.setApiVersion("2024-01");
    console.log( boardId, itemId, columnId, value);
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

module.exports = {
  getColumnValue,
  changeColumnValue,
};
