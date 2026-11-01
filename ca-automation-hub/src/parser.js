const Anthropic = require('@anthropic-ai/sdk');
const { logParsedDocumentToSheet } = require('./lib/googleSheets');
require('dotenv').config();

/**
 * Inspects document text, PDF base64, or Image base64 using Claude API (claude-opus-5-5)
 * and extracts financial summaries (Total Sales, Tax, Date Range, GSTIN, etc.).
 *
 * @param {Object} input
 * @param {string} [input.text] - Raw text extracted from file or OCR
 * @param {string} [input.base64Pdf] - Base64 encoded PDF
 * @param {string} [input.base64Image] - Base64 encoded Image (PNG/JPEG)
 * @param {string} [input.mediaType] - Media type e.g. "image/png", "image/jpeg"
 * @param {string} [input.fileName] - Name of uploaded file
 * @param {string} [input.clientId] - Associated Client ID
 * @param {string} [input.businessName] - Associated Business Name
 * @returns {Promise<Object>} Parsed financial summary
 */
async function parseFinancialDocument({
  text,
  base64Pdf,
  base64Image,
  mediaType = 'image/png',
  fileName = 'document.pdf',
  clientId,
  businessName
}) {
  console.log(`[Document Parser] Processing document "${fileName}" for client ${clientId || 'Unknown'}...`);

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      clientId,
      businessName,
      fileName,
      status: 'not_configured',
      message: 'Automatic document parsing is not configured. The uploaded file has been retained for manual review.'
    };
  }

  const contentBlocks = [];

  // System prompt guiding financial document extraction for CAs
  const systemPrompt = `You are an expert CA (Chartered Accountant) Financial Document Auditor in India.
Analyze the provided document (GST Return, Invoice, Bank Statement, or Financial Summary) and extract the financial data into a clean, strictly valid JSON object.

Your output must be ONLY a valid JSON object matching this structure:
{
  "documentType": "GST R1" | "GST R3B" | "Bank Statement" | "Tax Invoice" | "Tally Backup" | "Other",
  "gstin": "extracted GSTIN if present, or null",
  "dateRange": {
    "startDate": "YYYY-MM-DD or string",
    "endDate": "YYYY-MM-DD or string",
    "period": "Month/Quarter/Year"
  },
  "totalSales": "Total sales or taxable turnover amount as string/number (e.g., 150000.00)",
  "totalTax": "Total tax liability/paid as string/number (e.g., 27000.00)",
  "taxBreakdown": {
    "cgst": "number or null",
    "sgst": "number or null",
    "igst": "number or null"
  },
  "rawSummary": "A brief 2-3 sentence financial summary of the document for the CA",
  "confidenceScore": 0.95
}`;

  if (base64Pdf) {
    contentBlocks.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64Pdf
      }
    });
    contentBlocks.push({
      type: 'text',
      text: `Extract financial metrics from this PDF document named "${fileName}".`
    });
  } else if (base64Image) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Image
      }
    });
    contentBlocks.push({
      type: 'text',
      text: `Extract financial metrics from this image document named "${fileName}".`
    });
  } else if (text) {
    contentBlocks.push({
      type: 'text',
      text: `Analyze the following extracted document text from "${fileName}":\n\n${text}`
    });
  } else {
    return { clientId, businessName, fileName, status: 'skipped', message: 'No document content was provided for parsing.' };
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: contentBlocks
        }
      ]
    });

    let rawOutput = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        rawOutput += block.text;
      }
    }

    // Parse JSON from output
    let parsedData = {};
    try {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[0]);
      } else {
        parsedData = JSON.parse(rawOutput);
      }
    } catch (parseErr) {
      console.warn('Could not parse JSON response directly from Claude, using fallback object.');
      parsedData = {
        documentType: 'Financial Document',
        rawSummary: rawOutput,
        confidenceScore: 0.7
      };
    }

    const fullRecord = {
      clientId,
      businessName,
      fileName,
      status: 'parsed',
      ...parsedData
    };

    console.log('[Document Parser] Successfully parsed document:', fullRecord);

    await logParsedDocumentToSheet(fullRecord);

    return fullRecord;
  } catch (err) {
    console.error('Error invoking Claude API for document parsing:', err.message);
    return {
      clientId,
      businessName,
      fileName,
      status: 'failed',
      message: `Automatic parsing failed: ${err.message}`
    };
  }
}

module.exports = { parseFinancialDocument };
