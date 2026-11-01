const nodemailer = require('nodemailer');

let transporter;

function isEmailConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function getTransporter() {
  if (!isEmailConfigured()) {
    throw new Error('Email is not configured. Set EMAIL_USER and EMAIL_PASS.');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function buildReminderEmail(client, missingDocuments, uploadUrl) {
  const businessName = String(client.businessName || 'your business').replace(/[\r\n]+/g, ' ').trim();
  const name = String(client.name || 'Client').replace(/[\r\n]+/g, ' ').trim();
  const documentList = missingDocuments.map(item => String(item));
  const listHtml = documentList.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const listText = documentList.map(item => `- ${item}`).join('\n');
  const safeUploadUrl = escapeHtml(uploadUrl);

  return {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || '',
    to: client.email,
    subject: `Document reminder: pending items for ${businessName}`,
    text: `Hello ${name},\n\nPlease upload these pending documents for ${businessName}:\n${listText}\n\nUpload documents here: ${uploadUrl}\n`,
    html: `<!doctype html><html><body><p>Hello ${escapeHtml(name)},</p><p>Please upload these pending documents for <strong>${escapeHtml(businessName)}</strong>:</p><ul>${listHtml}</ul><p><a href="${safeUploadUrl}">Open your secure upload portal</a></p><p>Thank you.</p></body></html>`
  };
}

async function sendDocumentReminder(client, missingDocuments, uploadUrl) {
  if (!client.email) throw new Error('Client email address is missing.');
  return getTransporter().sendMail(buildReminderEmail(client, missingDocuments, uploadUrl));
}

module.exports = { isEmailConfigured, buildReminderEmail, sendDocumentReminder };
