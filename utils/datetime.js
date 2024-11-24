const { DateTime } = require('luxon');

function getCurrentESTDateTime() {
  return DateTime.now().setZone('America/New_York').toISO();
}

function convertToEST(utcDateString) {
  return DateTime.fromISO(utcDateString).setZone('America/New_York').toISO();
}

module.exports = { getCurrentESTDateTime, convertToEST };
