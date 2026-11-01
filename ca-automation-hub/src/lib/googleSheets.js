const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');
const path = require('path');
const { readState } = require('./storage');
require('dotenv').config();

// Service account JSON key file or environment variable
let creds = null;
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
  }
} else if (fs.existsSync(path.join(__dirname, '../../google-credentials.json'))) {
  try {
    creds = JSON.parse(fs.readFileSync(path.join(__dirname, '../../google-credentials.json')));
  } catch (e) {
    console.error('Failed to read google-credentials.json:', e.message);
  }
}

async function getSettings() {
  return readState('settings');
}

async function updateClientStatusInSheet(clientData) {
  if (!creds) {
    console.warn('Google Sheets credentials not found. Skipping sheet update.');
    return;
  }

  const settings = await getSettings();
  const doc = new GoogleSpreadsheet(settings.googleSheets.spreadsheetId);

  try {
    await doc.useServiceAccountAuth(creds);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[settings.googleSheets.sheetName];
    if (!sheet) {
      console.warn(`Sheet "${settings.googleSheets.sheetName}" not found.`);
      return;
    }

    const rows = await sheet.getRows();
    const row = rows.find(r => r.id === clientData.id);
    const pendingDocuments = (clientData.documentChecklist || [])
      .filter(item => !item.submitted)
      .map(item => item.title || item.label || item.id)
      .join(', ');

    if (row) {
      row.status = clientData.status;
      row.pendingDocuments = pendingDocuments;
      row.lastUpdated = new Date().toISOString();
      await row.save();
    } else {
      await sheet.addRow({
        id: clientData.id,
        name: clientData.name,
        businessName: clientData.businessName,
        status: clientData.status,
        pendingDocuments,
        lastUpdated: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('Error updating Google Sheet:', err);
  }
}

async function logParsedDocumentToSheet(parsedRecord) {
  if (!creds) {
    console.warn('Google Sheets credentials not configured. Skipping parsed document logging.');
    return;
  }

  const settings = await getSettings();
  const doc = new GoogleSpreadsheet(settings.googleSheets.spreadsheetId);

  try {
    await doc.useServiceAccountAuth(creds);
    await doc.loadInfo();
    const sheetTitle = settings.googleSheets.parsedDocsSheetName || 'ParsedDocuments';
    let sheet = doc.sheetsByTitle[sheetTitle];

    if (!sheet) {
      sheet = await doc.addSheet({
        title: sheetTitle,
        headerValues: [
          'timestamp',
          'clientId',
          'businessName',
          'fileName',
          'documentType',
          'gstin',
          'dateRange',
          'totalSales',
          'totalTax',
          'taxBreakdown',
          'notes'
        ]
      });
    }

    await sheet.addRow({
      timestamp: new Date().toISOString(),
      clientId: parsedRecord.clientId || 'N/A',
      businessName: parsedRecord.businessName || 'N/A',
      fileName: parsedRecord.fileName || 'N/A',
      documentType: parsedRecord.documentType || 'N/A',
      gstin: parsedRecord.gstin || 'N/A',
      dateRange: typeof parsedRecord.dateRange === 'object'
        ? `${parsedRecord.dateRange.startDate || ''} to ${parsedRecord.dateRange.endDate || ''} (${parsedRecord.dateRange.period || ''})`
        : String(parsedRecord.dateRange || 'N/A'),
      totalSales: parsedRecord.totalSales ?? 'N/A',
      totalTax: parsedRecord.totalTax ?? 'N/A',
      taxBreakdown: typeof parsedRecord.taxBreakdown === 'object'
        ? JSON.stringify(parsedRecord.taxBreakdown)
        : String(parsedRecord.taxBreakdown || 'N/A'),
      notes: parsedRecord.rawSummary || ''
    });

    console.log(`[Google Sheets] Successfully logged parsed document for client ${parsedRecord.clientId}`);
  } catch (err) {
    console.error('Error logging parsed document to Google Sheet:', err.message);
  }
}

module.exports = {
  updateClientStatusInSheet,
  logParsedDocumentToSheet
};
