/**
 * Backward compatibility layer redirecting OpenAI requests to Gemini API
 */
import { callGemini } from './gemini.js';
import genAI from './gemini.js';

export const callOpenAI = callGemini;
export default genAI;
