const crypto = require('crypto');
const { readActivityLogs, insertActivityLog } = require('./storage');

async function getAuditLogs(caId) {
  return readActivityLogs(caId);
}

async function logActivity({ caId, email, eventType, action, clientId, clientName, details }) {
  const newLog = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    eventType,
    action: action || eventType,
    caId: caId || null,
    email: email || '',
    clientId: clientId || null,
    clientName: clientName || 'System',
    details: details || ''
  };

  return insertActivityLog(newLog);
}

module.exports = {
  getAuditLogs,
  logActivity
};
