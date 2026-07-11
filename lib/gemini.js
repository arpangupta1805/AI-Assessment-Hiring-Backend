import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Gemini client
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.warn('⚠️ WARNING: GEMINI_API_KEY is not defined in the environment variables.');
}
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Cost rates per 1M tokens (approximate as of Gemini 2.5/1.5 pricing)
const MODEL_RATES_PER_1M = {
    'gemini-2.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-2.5-pro': { input: 1.25, output: 5.00 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
};

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 characters)
 */
const estimateTokens = (text) => {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
};

/**
 * Map OpenAI models to their closest Gemini counterparts, or return the model if it's already a Gemini model.
 */
const mapModel = (modelName) => {
    const defaultModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const largeModel = process.env.GEMINI_LARGE_MODEL || 'gemini-2.5-pro';

    if (!modelName) return defaultModel;

    const lowerModel = modelName.toLowerCase();

    // If it's already a gemini model identifier, return it
    if (lowerModel.startsWith('gemini-')) {
        return modelName;
    }

    // Map OpenAI models
    if (lowerModel.includes('gpt-4o') || lowerModel.includes('gpt-3.5') || lowerModel.includes('smaller')) {
        return defaultModel;
    }
    if (lowerModel.includes('gpt-4')) {
        return largeModel;
    }

    return defaultModel;
};

/**
 * Helper function to call Gemini API with retry logic and JSON mode
 * @param {string} prompt - The prompt to send to Gemini
 * @param {string} modelName - Optional model name (default: gemini-2.5-flash or env var)
 * @param {boolean} jsonMode - Whether to enforce JSON output
 * @param {number} maxRetries - Number of retries on failure (default: 3)
 * @param {number} temperature - Variation in response (default: 0.7)
 * @returns {Promise<any>} - The response (parsed JSON if jsonMode is true, string otherwise)
 */
export const callGemini = async (prompt, modelName = null, jsonMode = false, maxRetries = 3, temperature = 0.7) => {
    if (!genAI) {
        throw new Error('Google Generative AI client is not initialized. Please ensure GEMINI_API_KEY is configured.');
    }

    const model = mapModel(modelName);
    const promptTokens = estimateTokens(prompt);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            console.log(`📡 Calling Gemini API (${model}) (attempt ${attempt + 1}/${maxRetries})...`);

            const generationConfig = {
                temperature: temperature,
            };

            if (jsonMode) {
                generationConfig.responseMimeType = 'application/json';
            }

            const modelInstance = genAI.getGenerativeModel({
                model: model,
                systemInstruction: 'You are a helpful assistant.',
                generationConfig: generationConfig,
            });

            const result = await modelInstance.generateContent(prompt);
            const content = result.response.text();

            // Estimate response tokens and compute costs
            const responseTokens = estimateTokens(content);
            const rates = MODEL_RATES_PER_1M[model] || MODEL_RATES_PER_1M['gemini-2.5-flash'];
            const inputCost = (promptTokens / 1000000) * rates.input;
            const outputCost = (responseTokens / 1000000) * rates.output;
            const totalCost = inputCost + outputCost;

            console.log(`✅ Gemini call successful. Approx cost: $${totalCost.toFixed(6)}`);

            if (jsonMode) {
                try {
                    // Strip markdown code blocks if present
                    let cleanContent = content.trim();
                    if (cleanContent.startsWith('```json')) {
                        cleanContent = cleanContent.replace(/^```json\s*/, '').replace(/```\s*$/, '');
                    } else if (cleanContent.startsWith('```')) {
                        cleanContent = cleanContent.replace(/^```\s*/, '').replace(/```\s*$/, '');
                    }

                    return JSON.parse(cleanContent);
                } catch (parseError) {
                    console.error('❌ Failed to parse JSON response:', parseError);
                    console.log('Raw response:', content);
                    throw new Error('Invalid JSON response from Gemini');
                }
            }

            return content;
        } catch (error) {
            console.error(`❌ Gemini API Error (attempt ${attempt + 1}):`, error.message);

            if (attempt === maxRetries - 1) {
                throw error;
            }

            // Exponential backoff
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`⚠️ Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

export default genAI;
