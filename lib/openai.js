
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Cost rates per 1K tokens (approximate)
const MODEL_RATES_PER_1K = {
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
};

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 characters)
 */
const estimateTokens = (text) => {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
};

/**
 * Helper function to call OpenAI API with retry logic
 * @param {string} prompt - The prompt to send to OpenAI
 * @param {string} modelName - Optional model name (default: gpt-4o or env var)
 * @param {boolean} jsonMode - Whether to enforce JSON output
 * @param {number} maxRetries - Number of retries on failure (default: 3)
 * @param {number} temperature - Variation in response (default: 0.7)
 * @returns {Promise<any>} - The response (parsed JSON if jsonMode is true, string otherwise)
 */
export const callOpenAI = async (prompt, modelName = null, jsonMode = false, maxRetries = 3, temperature = 0.7) => {
    const model = modelName || process.env.OPENAI_MODEL || 'gpt-4o';

    // Estimate prompt tokens
    const promptTokens = estimateTokens(prompt);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            console.log(`📡 Calling OpenAI API (${model}) (attempt ${attempt + 1}/${maxRetries})...`);

            const completion = await openai.chat.completions.create({
                messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: prompt }],
                model: model,
                response_format: jsonMode ? { type: "json_object" } : { type: "text" },
                temperature: temperature,
            });

            const content = completion.choices[0].message.content;

            // Estimate response tokens
            const responseTokens = estimateTokens(content);
            const rates = MODEL_RATES_PER_1K[model] || MODEL_RATES_PER_1K['gpt-4o'];
            const inputCost = (promptTokens / 1000) * rates.input;
            const outputCost = (responseTokens / 1000) * rates.output;
            const totalCost = inputCost + outputCost;

            console.log(`✅ OpenAI call successful. Approx cost: $${totalCost.toFixed(6)}`);

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
                    // If parsing fails, throw error to trigger retry (if retries left)
                    throw new Error('Invalid JSON response from OpenAI');
                }
            }

            return content;
        } catch (error) {
            console.error(`❌ OpenAI API Error (attempt ${attempt + 1}):`, error.message);

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

export default openai;
