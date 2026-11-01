function sanitizePracticeSettings(settings = {}) {
  const { auth, whatsapp = {}, ...publicSettings } = settings;
  publicSettings.whatsapp = {
    phoneNumberId: whatsapp.phoneNumberId || '',
    webhookUrl: whatsapp.webhookUrl || '',
    templateName: whatsapp.templateName || 'document_reminder',
    languageCode: whatsapp.languageCode || 'en_US',
    apiVersion: whatsapp.apiVersion || 'v22.0',
    accessTokenConfigured: Boolean(whatsapp.accessToken)
  };
  return publicSettings;
}

module.exports = { sanitizePracticeSettings };
