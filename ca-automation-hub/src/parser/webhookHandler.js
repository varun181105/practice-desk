const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { updateClientStatusInSheet } = require('../lib/googleSheets');
const { logActivity } = require('../lib/auditLogger');
const { readState, writeState } = require('../lib/storage');

const uploadsPath = path.join(__dirname, '../../data/uploads');
const maxFileSize = 10 * 1024 * 1024;
const allowedTypes = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

async function getClients() {
  return readState('clients');
}

function findClientByPortalToken(clients, portalToken) {
  return clients.find(client => client.uploadToken === portalToken);
}

async function saveClients(clients) {
  return writeState('clients', clients);
}

async function calculateDashboardStats(clients = null) {
  if (!clients) clients = await getClients();
  let total = clients.length;
  let completed = 0;
  let pending = 0;

  clients.forEach(client => {
    if (client.status === 'Completed') {
      completed++;
    } else {
      pending++;
    }
  });

  return { total, completed, pending };
}

function updateClientStatus(client) {
  const checklist = client.documentChecklist || [];
  const submitted = checklist.filter(item => item.submitted).length;
  client.status = submitted === checklist.length
    ? 'Completed'
    : submitted > 0
      ? 'Partially Submitted'
      : 'Pending';
}

async function handleInboundUpdate(payload) {
  const { clientId, documentType, action = 'received' } = payload;
  const clients = await getClients();
  const clientIndex = clients.findIndex(c => c.id === clientId);

  if (clientIndex === -1) {
    console.error(`Client ${clientId} not found`);
    return { success: false, error: `Client with ID ${clientId} not found` };
  }

  const client = clients[clientIndex];

  if (action === 'received') {
    if (documentType && client.documentChecklist) {
      client.documentChecklist.forEach(item => {
        const title = item.title || item.label || '';
        if (title.toLowerCase().includes(documentType.toLowerCase()) || documentType.toLowerCase().includes(title.toLowerCase())) {
          item.submitted = true;
        }
      });
    }

    updateClientStatus(client);

    await saveClients(clients);
    updateClientStatusInSheet(client).catch(err => console.error('Failed to update Google Sheets:', err.message));

    await logActivity({
      eventType: 'DOCUMENT_UPLOADED',
      caId: client.caId,
      email: client.email,
      clientId: client.id,
      clientName: client.businessName,
      details: `Document received via webhook: ${documentType || 'General Document'}`
    });

    return {
      success: true,
      client,
      stats: await calculateDashboardStats(clients)
    };
  }

  return { success: false, error: `Unknown action "${action}"` };
}

async function handleSubmitDocuments({ portalToken, files }) {
  const clients = await getClients();
  const clientIndex = clients.findIndex(c => c.uploadToken === portalToken);

  if (clientIndex === -1) {
    return { success: false, error: 'Client portal link not found.' };
  }

  const client = clients[clientIndex];

  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
    return { success: false, error: 'Select at least one document before submitting.' };
  }

  const parsePromises = [];
  const uploadedFileNames = [];
  const savedFiles = [];
  const validatedFiles = [];

  for (const [itemId, fileData] of Object.entries(files || {})) {
    const item = (client.documentChecklist || []).find(i => i.id === itemId);
    if (!item) {
      return { success: false, error: `Document requirement "${itemId}" was not found.` };
    }

    if (!fileData || typeof fileData.base64 !== 'string' || !allowedTypes[fileData.type]) {
      return { success: false, error: `The file for "${item.title || item.label || itemId}" must be a PDF, JPEG, PNG, or WebP image.` };
    }

    const buffer = Buffer.from(fileData.base64, 'base64');
    if (!buffer.length || buffer.length > maxFileSize) {
      return { success: false, error: 'Each document must be smaller than 10 MB.' };
    }

    validatedFiles.push({ itemId, item, fileData, buffer });
  }

  for (const { itemId, item, fileData, buffer } of validatedFiles) {
    const extension = allowedTypes[fileData.type];
    const storedName = `${crypto.randomUUID()}${extension}`;
    fs.mkdirSync(uploadsPath, { recursive: true });
    fs.writeFileSync(path.join(uploadsPath, storedName), buffer, { flag: 'wx' });

    item.submitted = true;
    item.fileName = path.basename(String(fileData.name || `document${extension}`)).slice(0, 180);
    item.storedAs = storedName;
    item.submittedAt = new Date().toISOString();
    uploadedFileNames.push(item.title || item.label || itemId);
    savedFiles.push({ itemId, item, fileData });
  }

  updateClientStatus(client);

  await saveClients(clients);
  updateClientStatusInSheet(client).catch(err => console.error('Failed to update Google Sheets:', err.message));

  await logActivity({
    eventType: 'DOCUMENT_UPLOADED',
    caId: client.caId,
    email: client.email,
    clientId: client.id,
    clientName: client.businessName,
    details: `Documents uploaded via mobile portal: ${uploadedFileNames.join(', ')}`
  });

  for (const { itemId, item, fileData } of savedFiles) {
    try {
      const { parseFinancialDocument } = require('../parser');
      parsePromises.push(parseFinancialDocument({
        base64Pdf: fileData.type === 'application/pdf' ? fileData.base64 : null,
        base64Image: fileData.type.startsWith('image/') ? fileData.base64 : null,
        mediaType: fileData.type,
        fileName: item.fileName,
        clientId: client.id,
        businessName: client.businessName
      }).then(result => ({ itemId, ...result })));
    } catch (err) {
      parsePromises.push(Promise.resolve({ itemId, status: 'unavailable', error: err.message }));
    }
  }

  const parsedResults = await Promise.all(parsePromises);

  return {
    success: true,
    message: 'Documents received successfully.',
    uploadedCount: savedFiles.length
  };
}

module.exports = {
  handleInboundUpdate,
  handleSubmitDocuments,
  calculateDashboardStats,
  getClients,
  findClientByPortalToken
};
