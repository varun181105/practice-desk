const axios = require('axios');

function normalizeWhatsAppPhone(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function buildWhatsAppWebhookPayload(client, missingDocuments, uploadUrl) {
  return {
    type: 'DOCUMENT_REMINDER',
    channel: 'whatsapp',
    to: normalizeWhatsAppPhone(client.whatsappPhone),
    client: {
      id: client.id,
      name: client.name,
      businessName: client.businessName
    },
    missingDocuments: missingDocuments.map(String),
    uploadUrl,
    timestamp: new Date().toISOString()
  };
}

function buildMetaTemplatePayload(client, missingDocuments, uploadUrl, config) {
  const recipient = normalizeWhatsAppPhone(client.whatsappPhone);
  if (!/^\d{8,15}$/.test(recipient)) throw new Error('Client WhatsApp number must include its country code.');
  if (!config.phoneNumberId || !config.accessToken) throw new Error('Configure the Meta WhatsApp phone number ID and access token.');

  return {
    url: `https://graph.facebook.com/${config.apiVersion || 'v22.0'}/${encodeURIComponent(config.phoneNumberId)}/messages`,
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: config.templateName || 'document_reminder',
        language: { code: config.languageCode || 'en_US' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: String(client.businessName || 'your business').slice(0, 1000) },
            { type: 'text', text: missingDocuments.map(String).join(', ').slice(0, 1000) },
            { type: 'text', text: uploadUrl.slice(0, 1000) }
          ]
        }]
      }
    }
  };
}

async function sendWhatsAppReminder(settings, client, missingDocuments, uploadUrl) {
  const config = settings.whatsapp || {};
  const recipient = normalizeWhatsAppPhone(client.whatsappPhone);
  if (!/^\d{8,15}$/.test(recipient)) throw new Error('Client WhatsApp number must include its country code.');

  const webhookUrl = config.webhookUrl || settings.n8n?.webhookUrl;
  if (webhookUrl) {
    await axios.post(webhookUrl, buildWhatsAppWebhookPayload(client, missingDocuments, uploadUrl), { timeout: 10000 });
    return { channel: 'whatsapp_webhook' };
  }

  const request = buildMetaTemplatePayload(client, missingDocuments, uploadUrl, config);
  await axios.post(request.url, request.body, { headers: request.headers, timeout: 10000 });
  return { channel: 'whatsapp' };
}

module.exports = {
  normalizeWhatsAppPhone,
  buildWhatsAppWebhookPayload,
  buildMetaTemplatePayload,
  sendWhatsAppReminder
};
