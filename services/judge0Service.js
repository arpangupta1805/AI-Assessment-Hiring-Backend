import axios from 'axios';

// Judge0 Language IDs - Add more as needed
export const LANGUAGE_IDS = {
    'javascript': 63,      // Node.js
    'python': 71,          // Python 3
    'java': 62,            // Java
    'cpp': 54,             // C++ (GCC 9.2.0)
    'c': 50,               // C (GCC 9.2.0)
    'csharp': 51,          // C# (Mono 6.6.0.161)
    'go': 60,              // Go
    'ruby': 72,            // Ruby
    'rust': 73,            // Rust
    'kotlin': 78,          // Kotlin
    'swift': 83,           // Swift
    'typescript': 74,      // TypeScript
    'php': 68,             // PHP
    'sql': 82,             // SQL (SQLite)
};

class Judge0Service {
    constructor() {
        this.apiKey = process.env.JUDGE0_API_KEY || "72f66a5afbmsh8a71bd2253cc72dp1bc296jsn9cf88e045e45";
        this.apiUrl = process.env.JUDGE0_API_URL || 'https://judge0-ce.p.rapidapi.com';
        this.host = process.env.JUDGE0_HOST || 'judge0-ce.p.rapidapi.com';
        
        if (!this.apiKey) {
            console.warn('⚠️  JUDGE0_API_KEY is not set. Code execution will fail.');
        }

        this.headers = {
            'content-type': 'application/json',
            'X-RapidAPI-Key': this.apiKey,
            'X-RapidAPI-Host': this.host,
        };
    }

    /**
     * Submit code for execution
     * @param {string} code - Source code
     * @param {number} languageId - Judge0 language ID
     * @param {string} stdin - Standard input
     * @param {number} timeLimit - Time limit in seconds (default: 5)
     * @param {number} memoryLimit - Memory limit in KB (default: 128000)
     * @returns {Promise<{token: string}>}
     */
    async submitCode(code, languageId, stdin = '', timeLimit = 5, memoryLimit = 128000) {
        try {
            const response = await axios.post(
                `${this.apiUrl}/submissions?base64_encoded=false&wait=false`,
                {
                    source_code: code,
                    language_id: languageId,
                    stdin: stdin,
                    cpu_time_limit: timeLimit,
                    memory_limit: memoryLimit,
                },
                { headers: this.headers }
            );

            return { token: response.data.token };
        } catch (error) {
            console.error('Error submitting code to Judge0:', error.response?.data || error.message);
        }
    }

    /**
     * Get submission result
     * @param {string} token - Submission token
     * @returns {Promise<Object>}
     */
    async getSubmission(token) {
        try {
            const response = await axios.get(
                `${this.apiUrl}/submissions/${token}?base64_encoded=false`,
                { headers: this.headers }
            );

            return response.data;
        } catch (error) {
            console.error('Error getting submission from Judge0:', error.response?.data || error.message);
            throw new Error('Failed to get submission result');
        }
    }

    /**
     * Submit code and wait for result (polling)
     * @param {string} code - Source code
     * @param {number} languageId - Judge0 language ID
     * @param {string} stdin - Standard input
     * @param {number} maxRetries - Maximum number of polling attempts
     * @returns {Promise<Object>}
     */
    async executeCode(code, languageId, stdin = '', maxRetries = 10) {
        const { token } = await this.submitCode(code, languageId, stdin);

        let retries = 0;
        while (retries < maxRetries) {
            await this.sleep(1000); // Wait 1 second between polls

            const result = await this.getSubmission(token);

            // Status IDs: 1=In Queue, 2=Processing
            if (result.status.id > 2) {
                return this.formatResult(result);
            }

            retries++;
        }

        throw new Error('Execution timeout: Maximum polling attempts reached');
    }

    /**
     * Run code against multiple test cases (BATCHED - LeetCode style)
     * Combines multiple test cases into a single combined input/output for fewer API calls
     * @param {string} code - Source code
     * @param {number} languageId - Judge0 language ID
     * @param {Array} testCases - Array of test cases with input/output
     * @returns {Promise<Array>}
     */
    async runTestCases(code, languageId, testCases) {
        if (!testCases || testCases.length === 0) {
            return [];
        }

        // For most languages, batch multiple test cases into single execution
        // This reduces API calls significantly and avoids "Too many requests" errors
        const batchSize = 5; // Group up to 5 test cases per batch
        const results = [];

        // Process test cases in batches
        for (let i = 0; i < testCases.length; i += batchSize) {
            const batch = testCases.slice(i, i + batchSize);
            
            try {
                // Combine all test case inputs into a single stdin
                const combinedInput = batch.map(tc => tc.input).join('\n---TEST_CASE_SEPARATOR---\n');
                const expectedOutputs = batch.map(tc => tc.expectedOutput);

                // Run combined batch
                const result = await this.executeCode(code, languageId, combinedInput);
                const outputLines = (result.stdout || '').split('\n---TEST_CASE_SEPARATOR---\n');

                // Process each test case result in the batch
                batch.forEach((testCase, idx) => {
                    const actualOutput = outputLines[idx] || '';
                    const expectedOutput = expectedOutputs[idx];
                    
                    const passed = this.compareOutputs(
                        actualOutput.trim(),
                        expectedOutput?.trim() || ''
                    );

                    results.push({
                        testType: testCase.type,
                        testNumber: testCase.number,
                        passed,
                        expectedOutput: expectedOutput,
                        actualOutput: actualOutput,
                        executionTime: result.time,
                        memory: result.memory,
                        error: result.stderr || result.compile_output || null,
                        status: result.status,
                    });
                });
            } catch (error) {
                // If batch fails, return errors for all test cases in batch
                batch.forEach((testCase) => {
                    results.push({
                        testType: testCase.type,
                        testNumber: testCase.number,
                        passed: false,
                        expectedOutput: testCase.expectedOutput,
                        actualOutput: '',
                        error: error.message,
                        status: 'error',
                    });
                });
            }
        }

        return results;
    }

    /**
     * Compare outputs (handles different line endings and trailing whitespace)
     */
    compareOutputs(actual, expected) {
        const normalizeOutput = (str) => {
            return str
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .trim()
                .split('\n')
                .map(line => line.trim())
                .join('\n');
        };

        return normalizeOutput(actual) === normalizeOutput(expected);
    }

    /**
     * Format Judge0 result
     */
    formatResult(result) {
        const statusMap = {
            3: 'success',           // Accepted
            4: 'failed',            // Wrong Answer
            5: 'time-limit-exceeded',
            6: 'compilation-error',
            7: 'error',             // Runtime Error (SIGSEGV)
            8: 'error',             // Runtime Error (SIGXFSZ)
            9: 'error',             // Runtime Error (SIGFPE)
            10: 'error',            // Runtime Error (SIGABRT)
            11: 'error',            // Runtime Error (NZEC)
            12: 'error',            // Runtime Error (Other)
            13: 'error',            // Internal Error
            14: 'error',            // Exec Format Error
        };

        return {
            status: statusMap[result.status.id] || 'error',
            statusDescription: result.status.description,
            stdout: result.stdout,
            stderr: result.stderr,
            compile_output: result.compile_output,
            time: result.time,
            memory: result.memory,
            exitCode: result.exit_code,
        };
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get language ID from language name
     */
    getLanguageId(language) {
        const langId = LANGUAGE_IDS[language.toLowerCase()];
        if (!langId) {
            throw new Error(`Unsupported language: ${language}`);
        }
        return langId;
    }

    /**
     * Get supported languages
     */
    getSupportedLanguages() {
        return Object.keys(LANGUAGE_IDS).map(lang => ({
            name: lang,
            id: LANGUAGE_IDS[lang],
        }));
    }
}

export default new Judge0Service();
