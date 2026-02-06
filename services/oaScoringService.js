class OAScoringService {
    constructor() {
        // Scoring weights
        this.weights = {
            correctness: 0.6,
            performance: 0.15,
            codeQuality: 0.1,
            edgeCases: 0.05,
            approach: 0.1,
        };

        // Difficulty weights for overall score calculation
        this.difficultyWeights = {
            easy: 1,
            medium: 1.5,
            hard: 2,
            expert: 3,
        };

        // Difficulty descriptions for LLM prompt generation
        this.difficultyDescriptions = {
            easy: 'Basic questions on arrays, permutations, binary search and its applications, simple string manipulation, basic math problems, and fundamental data structures',
            medium: 'Sliding window techniques, recursion, tree traversals and applications, hash maps, two pointers, backtracking, basic dynamic programming, and graph fundamentals',
            hard: 'Master level questions mixing multiple concepts like DP with trees, advanced graph algorithms, complex recursion with memoization, segment trees, and multi-dimensional problem-solving',
            expert: 'Very hard Candidate Master level problems requiring deep algorithmic knowledge, advanced DP patterns, complex graph theory, mathematical proofs, and optimization techniques'
        };
    }

    /**
     * Helper function to call Gemini API with retry logic
     */
    async callGemini(prompt, modelName = null, temperature = 0.7, maxRetries = 3) {
        const model = modelName || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`📡 Calling Gemini API (attempt ${attempt + 1}/${maxRetries})...`);
                console.log(`📡 Model: ${model}`);
                console.log(`📡 Prompt length: ${prompt.length} chars`);
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: temperature,
                        },
                    }),
                });

                console.log(`📡 Response status: ${response.status}`);

                if (response.status === 429) {
                    const retryAfter = response.headers.get('retry-after');
                    const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 5000;
                    console.log(`⚠️  Rate limited. Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                    if (attempt < maxRetries - 1) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    } else {
                        throw new Error('Gemini API rate limit exceeded');
                    }
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`❌ API Error Response: ${errorText}`);
                    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
                }

                const jsonResponse = await response.json();
                console.log(`✅ API call successful, response received`);
                return jsonResponse;
            } catch (error) {
                console.error(`❌ Error in callGemini (attempt ${attempt + 1}):`, error.message);
                if (attempt === maxRetries - 1 || error.message.includes('rate limit')) {
                    throw error;
                }
                const delay = Math.pow(2, attempt) * 5000;
                console.log(`⚠️  Gemini API error: ${error.message}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Calculate correctness score based on test case results
     */
    calculateCorrectnessScore(testResults) {
        const visible = testResults.filter(t => t.testType === 'visible');
        const hidden = testResults.filter(t => t.testType === 'hidden');

        const visiblePassed = visible.filter(t => t.passed).length;
        const hiddenPassed = hidden.filter(t => t.passed).length;

        const visibleRate = visible.length > 0 ? visiblePassed / visible.length : 0;
        const hiddenRate = hidden.length > 0 ? hiddenPassed / hidden.length : 0;

        // Weighted: 40% visible, 60% hidden
        const correctnessScore = (visibleRate * 0.4 + hiddenRate * 0.6) * 60;

        return Math.round(correctnessScore * 10) / 10;
    }

    /**
     * Calculate performance score based on execution time
     */
    calculatePerformanceScore(testResults, estimatedTime) {
        if (testResults.length === 0) return 0;

        const avgExecutionTime = testResults.reduce((sum, t) => sum + (t.executionTime || 0), 0) / testResults.length;
        const timeLimitSeconds = estimatedTime * 60; // Convert minutes to seconds

        // Calculate ratio (lower execution time = better score)
        const performanceRatio = Math.max(0, (timeLimitSeconds - avgExecutionTime) / timeLimitSeconds);
        const performanceScore = performanceRatio * 15;

        return Math.round(performanceScore * 10) / 10;
    }

    /**
     * Calculate edge case score
     */
    calculateEdgeCaseScore(testResults) {
        const edgeCases = testResults.filter(t => t.testType === 'edge');
        
        if (edgeCases.length === 0) return 0;

        const edgePassed = edgeCases.filter(t => t.passed).length;
        const edgeCaseScore = (edgePassed / edgeCases.length) * 5;

        return Math.round(edgeCaseScore * 10) / 10;
    }

    /**
     * Use LLM to evaluate code quality
     */
    async evaluateCodeQuality(code, language) {
        const prompt = `You are an expert code reviewer. Evaluate the following ${language} code for:
1. Code readability and clarity
2. Variable naming conventions
3. Code structure and organization
4. Use of best practices
5. Modularity and reusability

Code:
\`\`\`${language}
${code}
\`\`\`

Provide a score out of 10 for code quality and a brief explanation (2-3 sentences).

Respond ONLY in JSON format:
{
  "score": <number between 0-10>,
  "explanation": "<brief explanation>"
}`;

        try {
            const modelName = process.env.GEMINI_CODE_QUALITY_MODEL || 'gemini-2.0-flash';
            const data = await this.callGemini(prompt, modelName, 0.7);
            const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            // Extract JSON from response
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    score: Math.round(parsed.score * 10) / 10,
                    explanation: parsed.explanation,
                };
            }
        } catch (error) {
            console.error('Error evaluating code quality:', error);
        }

        // Default score if LLM fails
        return { score: 5, explanation: 'Unable to evaluate code quality.' };
    }

    /**
     * Use LLM to analyze approach and generate feedback
     */
    async analyzeApproach(question, candidateCode, language, failedTestCases = []) {
        const failedTestsInfo = failedTestCases.length > 0
            ? `\n\nFailed Test Cases:\n${failedTestCases.map((tc, i) => 
                `Test ${i + 1}:\nInput: ${tc.input}\nExpected: ${tc.expectedOutput}\nActual: ${tc.actualOutput}`
              ).join('\n\n')}`
            : '';

        const prompt = `You are an expert programming interviewer analyzing a candidate's solution.

**Question:**
${question.questionText}

**Expected Approach:**
${question.howToApproach}

**Optimal Solution:**
${question.optimalSolution}

**Candidate's Code (${language}):**
\`\`\`${language}
${candidateCode}
\`\`\`
${failedTestsInfo}

Analyze the candidate's solution and provide:
1. **Your Approach**: Describe the approach used by the candidate (2-3 sentences)
2. **Time Complexity**: Big O notation of the candidate's solution
3. **Approach Score**: Score out of 10 comparing candidate's approach to optimal
4. **Overall Comments**: Constructive feedback on what went well and what can be improved. If there are failed test cases, explain why they failed and what's missing.

IMPORTANT: Respond in PLAIN TEXT JSON format. Do NOT use markdown code blocks, do NOT wrap in \`\`\`json or \`\`\`, just return the raw JSON object:
{
  "yourApproach": "<description of candidate's approach>",
  "timeComplexity": "<Big O notation>",
  "approachScore": <number between 0-10>,
  "overallComments": "<detailed feedback in plain text, no markdown formatting>"
}`;

        try {
            const modelName = process.env.GEMINI_APPROACH_MODEL || 'gemini-2.0-flash';
            const data = await this.callGemini(prompt, modelName, 0.7);
            const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    yourApproach: parsed.yourApproach,
                    timeComplexity: parsed.timeComplexity,
                    approachScore: Math.round(parsed.approachScore * 10) / 10,
                    overallComments: parsed.overallComments,
                };
            }
        } catch (error) {
            console.error('Error analyzing approach:', error);
        }

        // Default response if LLM fails
        return {
            yourApproach: 'Unable to analyze approach.',
            timeComplexity: 'N/A',
            approachScore: 5,
            overallComments: 'Please review the optimal solution and try again.',
        };
    }

    /**
     * Score a single question
     */
    async scoreQuestion(question, latestAttempt, testResults) {
        // 1. Correctness Score (60%)
        const correctnessScore = this.calculateCorrectnessScore(testResults);

        // 2. Performance Score (15%)
        const performanceScore = this.calculatePerformanceScore(testResults, question.estimatedTime);

        // 3. Edge Case Score (5%)
        const edgeCaseScore = this.calculateEdgeCaseScore(testResults);

        // 4. Code Quality Score (10%) - LLM
        const codeQualityResult = await this.evaluateCodeQuality(
            latestAttempt.code,
            latestAttempt.language
        );
        const codeQualityScore = codeQualityResult.score;

        // 5. Approach Score (10%) - LLM
        const failedTests = testResults.filter(t => !t.passed);
        const approachAnalysis = await this.analyzeApproach(
            question,
            latestAttempt.code,
            latestAttempt.language,
            failedTests
        );
        const approachScore = approachAnalysis.approachScore;

        // Calculate final score out of 100
        const totalScore = correctnessScore + performanceScore + codeQualityScore + edgeCaseScore + approachScore;
        const finalScore = Math.round(totalScore * 10) / 10;

        return {
            scores: {
                correctness: correctnessScore,
                performance: performanceScore,
                codeQuality: codeQualityScore,
                edgeCases: edgeCaseScore,
                approach: approachScore,
                finalScore: finalScore,
            },
            analysis: {
                howToApproach: question.howToApproach,
                yourApproach: approachAnalysis.yourApproach,
                optimalSolution: question.optimalSolution,
                yourSolution: latestAttempt.code,
                overallComments: approachAnalysis.overallComments,
                timeComplexity: approachAnalysis.timeComplexity,
            },
        };
    }

    /**
     * Calculate overall OA score from all questions
     */
    calculateOverallScore(questions) {
        let totalWeightedScore = 0;
        let totalWeight = 0;

        for (const question of questions) {
            const weight = this.difficultyWeights[question.difficulty] || 1;
            totalWeightedScore += question.scores.finalScore * weight;
            totalWeight += weight;
        }

        const overallScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
        
        // Normalize to 10
        const normalizedScore = (overallScore / 10).toFixed(1);

        return {
            overallScore: Math.round(overallScore * 10) / 10,
            normalizedScore: parseFloat(normalizedScore),
        };
    }

    /**
     * Helper: Sanitize JSON string by removing/escaping problematic characters
     */
    sanitizeJSONString(jsonStr) {
        if (!jsonStr || typeof jsonStr !== 'string') return jsonStr;
        
        // Remove control characters except for common escaped ones
        // ASCII control characters are 0x00-0x1F (0-31)
        let sanitized = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
        
        return sanitized;
    }

    /**
     * Helper: More aggressive JSON cleaning for LLM responses
     */
    aggressiveJSONClean(jsonStr) {
        if (!jsonStr || typeof jsonStr !== 'string') return jsonStr;
        
        try {
            // Remove any trailing commas before closing braces/brackets
            let cleaned = jsonStr.replace(/,(\s*[}\]])/g, '$1');
            
            return cleaned;
        } catch (e) {
            return jsonStr;
        }
    }

    /**
     * Helper: Pre-process JSON to fix code fields BEFORE parsing
     * This is more effective than post-processing
     */
    fixCodeFieldsBeforeParse(jsonStr) {
        if (!jsonStr || typeof jsonStr !== 'string') return jsonStr;
        
        try {
            // Strategy: Find optimalSolution fields and properly escape their content
            // The LLM often includes unescaped quotes and newlines in Python code
            
            let result = jsonStr;
            const fieldNames = ['optimalSolution', 'solution', 'code', 'implementation'];
            
            for (const fieldName of fieldNames) {
                // Find pattern: "fieldName": "...content..."
                // We need to handle cases where content has unescaped quotes and newlines
                
                // Use a more sophisticated approach: find the field, then parse its value carefully
                const fieldPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`, 'g');
                let match;
                let lastIndex = 0;
                let newResult = '';
                
                while ((match = fieldPattern.exec(result)) !== null) {
                    // Add everything before this match
                    newResult += result.substring(lastIndex, match.index + match[0].length);
                    
                    // Now find the closing quote of this field's value
                    // We need to handle escaped quotes properly
                    let pos = match.index + match[0].length;
                    let valueStart = pos;
                    let depth = 0;
                    let inEscape = false;
                    let foundEnd = false;
                    
                    while (pos < result.length) {
                        const char = result[pos];
                        
                        if (inEscape) {
                            inEscape = false;
                            pos++;
                            continue;
                        }
                        
                        if (char === '\\') {
                            inEscape = true;
                            pos++;
                            continue;
                        }
                        
                        if (char === '"') {
                            // Found the end of the value
                            const rawValue = result.substring(valueStart, pos);
                            
                            // Fix the value: escape quotes, newlines, tabs, backslashes
                            let fixedValue = rawValue;
                            
                            // Only fix if it looks like it needs fixing (has actual newlines or unescaped quotes)
                            const needsFix = /[\n\t\r]/.test(rawValue) || (/"/.test(rawValue) && !/\\"/.test(rawValue));
                            
                            if (needsFix) {
                                fixedValue = rawValue
                                    .replace(/\\/g, '\\\\')  // Escape backslashes first
                                    .replace(/"/g, '\\"')     // Escape quotes
                                    .replace(/\n/g, '\\n')    // Escape newlines
                                    .replace(/\r/g, '\\r')    // Escape carriage returns
                                    .replace(/\t/g, '\\t');   // Escape tabs
                            }
                            
                            newResult += fixedValue + '"';
                            lastIndex = pos + 1;
                            foundEnd = true;
                            break;
                        }
                        
                        pos++;
                    }
                    
                    if (!foundEnd) {
                        // Couldn't find end, keep original
                        newResult = result;
                        break;
                    }
                }
                
                // Add the rest of the string
                newResult += result.substring(lastIndex);
                result = newResult;
            }
            
            return result;
        } catch (e) {
            console.error('Error in fixCodeFieldsBeforeParse:', e);
            return jsonStr;
        }
    }

    /**
     * Helper: Fix code strings that break JSON (like optimalSolution)
     * Properly escape quotes, newlines, backslashes in code blocks
     */
    fixCodeFieldsInJSON(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        
        // Fields that typically contain code
        const codeFields = ['optimalSolution', 'solution', 'code', 'implementation'];
        
        for (const field of codeFields) {
            if (obj[field] && typeof obj[field] === 'string') {
                // Already properly escaped, don't double-escape
                if (obj[field].includes('\\n') || obj[field].includes('\\"')) {
                    continue;
                }
                
                // Escape backslashes first (must be first!)
                let fixed = obj[field].replace(/\\/g, '\\\\');
                // Escape quotes
                fixed = fixed.replace(/"/g, '\\"');
                // Escape actual newlines
                fixed = fixed.replace(/\n/g, '\\n');
                // Escape tabs
                fixed = fixed.replace(/\t/g, '\\t');
                
                obj[field] = fixed;
            }
        }
        
        // Recursively fix nested objects/arrays
        if (Array.isArray(obj)) {
            return obj.map(item => this.fixCodeFieldsInJSON(item));
        } else if (typeof obj === 'object') {
            const result = {};
            for (const key in obj) {
                result[key] = this.fixCodeFieldsInJSON(obj[key]);
            }
            return result;
        }
        
        return obj;
    }

    /**
     * Helper: extract first balanced JSON object from text
     */
    extractFirstBalancedJSON(text) {
        if (!text || typeof text !== 'string') return null;
        
        // First sanitize the text
        text = this.sanitizeJSONString(text);
        
        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            
            // Handle escape sequences
            if (escaped) {
                escaped = false;
                continue;
            }
            
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            
            // Handle string boundaries
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            
            // Only count braces outside of strings
            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
                
                if (depth === 0) {
                    const candidate = text.slice(start, i + 1);
                    try {
                        return JSON.parse(candidate);
                    } catch (e) {
                        console.error('JSON parse failed for candidate:', e.message);
                        console.error('Candidate substring (first 500 chars):', candidate.substring(0, 500));
                        return null;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Generate question using LLM based on company and role
     */
    async generateQuestion(company, role, difficulty, companyAbout) {
        const prompt = `You are an expert technical interviewer creating a COMPREHENSIVE CODING Online Assessment question with extensive test coverage.

**IMPORTANT: This MUST be a coding/programming question only. No MCQs, no theory questions.**

**Company:** ${company}
**Role:** ${role}
**Difficulty:** ${difficulty}
**About Company:** ${companyAbout}

Create a realistic CODING question that:
1. Aligns with ${company}'s technical focus and the ${role} level
2. Has difficulty level: ${difficulty}
3. Is a programming/coding challenge (NOT multiple choice or theory)
4. Includes visible test cases (EXACTLY 3 examples with clear input/output)
5. Includes hidden test cases (EXACTLY 5 test cases covering various conditions)
6. Includes edge test cases (EXACTLY 4 corner cases: empty, boundary, extreme values)
7. Has clear constraints
8. Includes "How to Approach" explanation
9. Includes optimal solution code in Python
10. Estimated time to solve (in minutes)

**CRITICAL TEST CASE REQUIREMENTS:**
- Generate EXACTLY 12 TOTAL test cases distributed as:
  * EXACTLY 3 visible test cases (for user understanding)
  * EXACTLY 5 hidden test cases (normal scenarios, variations)
  * EXACTLY 4 edge test cases (boundaries, extremes, special cases)
- Cover key scenarios: empty inputs, single elements, maximum values, minimum values
- Each test case MUST have distinct input and expected output
- Inputs and outputs must be realistic and testable

**CRITICAL JSON FORMATTING RULES - MUST FOLLOW:**
- Return ONLY valid JSON, no markdown code blocks, no extra text
- Ensure all strings are properly escaped
- Use double quotes for JSON keys and string values
- For ALL string values (especially optimalSolution and howToApproach):
  * Escape ALL double quotes inside strings as \"
  * Escape ALL backslashes as \\
  * Replace actual newlines with \\n (two characters: backslash + n)
  * Do NOT include literal newline characters in JSON strings
  * Example: "def solution():\\n    return True"
- For test case inputs/outputs:
  * Keep ALL strings on a SINGLE LINE - NO line breaks
  * Use compact array notation: [1,2,3]
  * Maximum 80 characters per input/output string
  * For arrays, use compact notation: "[1,2,3,4,5]"
  * For strings with quotes, escape them: "\"hello\""
  * NEVER split arrays or strings across multiple lines
- Number each test case sequentially: "1", "2", "3", etc.
- VALIDATE your JSON before returning

**IMPORTANT - Question Text Structure:**
- The "questionText" field should contain ONLY the problem statement/description
- DO NOT include examples, test cases, or explanations in questionText
- Examples are automatically shown from visibleTestcases, so don't duplicate them
- Keep questionText focused: problem description, input/output format, constraints overview
- Use markdown formatting for better readability (headers, bold, code blocks)

**IMPORTANT - Optimal Solution Format:**
- Write clean, working Python code WITHOUT excessive comments
- Use proper Python indentation (4 spaces)
- Keep code concise - under 50 lines
- Escape ALL quotes and newlines properly for JSON

Return this exact JSON structure:
{
  "questionId": "company-role-topic-difficulty",
  "questionText": "Complete problem description with examples",
  "constraints": ["Time limit: X seconds", "Memory limit: Y MB", "Other constraints..."],
  "visibleTestcases": {
    "1": {"input": "example input 1", "output": "expected output 1"},
    "2": {"input": "example input 2", "output": "expected output 2"},
    "3": {"input": "example input 3", "output": "expected output 3"}
  },
  "hiddenTestcases": {
    "1": {"input": "test case 1", "output": "expected 1"},
    "2": {"input": "test case 2", "output": "expected 2"},
    "3": {"input": "test case 3", "output": "expected 3"},
    "4": {"input": "test case 4", "output": "expected 4"},
    "5": {"input": "test case 5", "output": "expected 5"}
  },
  "edgeTestcases": {
    "1": {"input": "edge case 1 (empty)", "output": "expected 1"},
    "2": {"input": "edge case 2 (single element)", "output": "expected 2"},
    "3": {"input": "edge case 3 (max values)", "output": "expected 3"},
    "4": {"input": "edge case 4 (min values)", "output": "expected 4"}
  },
  "howToApproach": "Step-by-step approach explanation",
  "optimalSolution": "def solution():\\n    # Complete working Python code\\n    pass",
  "estimatedTime": 30,
  "difficulty": "${difficulty}",
  "role": "${role}",
  "company": "${company}"
}`;

        try {
            const modelName = process.env.GEMINI_QUESTION_GEN_MODEL || 'gemini-2.0-flash';
            const data = await this.callGemini(prompt, modelName, 0.7);
            const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            console.log('🤖 Raw AI Response (first 800 chars):', aiResponse.substring(0, 800));
            
            // Sanitize the response first
            const sanitizedResponse = this.sanitizeJSONString(aiResponse);
            
            // Remove markdown code blocks if present
            let cleanedResponse = sanitizedResponse.trim();
            if (cleanedResponse.startsWith('```json')) {
                cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/```\s*$/, '');
            } else if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/```\s*$/, '');
            }
            
            // Pre-process to fix code fields BEFORE parsing
            console.log('🔧 Pre-processing code fields...');
            cleanedResponse = this.fixCodeFieldsBeforeParse(cleanedResponse);
            
            // Try robust extraction first
            let result = this.extractFirstBalancedJSON(cleanedResponse);
            
            // Fallback to regex if balanced extraction fails
            if (!result) {
                const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const sanitizedMatch = this.sanitizeJSONString(jsonMatch[0]);
                    try {
                        result = JSON.parse(sanitizedMatch);
                    } catch (parseError) {
                        console.error('❌ Initial JSON parse error:', parseError.message);
                        
                        // Try with aggressive cleaning
                        try {
                            const aggressiveCleaned = this.aggressiveJSONClean(sanitizedMatch);
                            result = JSON.parse(aggressiveCleaned);
                            console.log('✅ Aggressive cleaning succeeded!');
                        } catch (finalError) {
                            console.error('❌ Final JSON parse error:', finalError.message);
                            console.error('Failed JSON string (first 500 chars):', sanitizedMatch.substring(0, 500));
                            result = null;
                        }
                    }
                }
            }
            
            // Fix code fields if parsed successfully
            if (result) {
                console.log('🔧 Applying code field fixes...');
                result = this.fixCodeFieldsInJSON(result);
            }
            
            if (result) {
                console.log('✅ Successfully parsed question:', result.questionId);
                // Log test case counts
                const visibleCount = result.visibleTestcases ? Object.keys(result.visibleTestcases).length : 0;
                const hiddenCount = result.hiddenTestcases ? Object.keys(result.hiddenTestcases).length : 0;
                const edgeCount = result.edgeTestcases ? Object.keys(result.edgeTestcases).length : 0;
                console.log(`📊 Test cases generated: ${visibleCount} visible, ${hiddenCount} hidden, ${edgeCount} edge (Total: ${visibleCount + hiddenCount + edgeCount})`);
                return result;
            }
            
            console.error('❌ Failed to extract JSON from response');
            console.error('Sanitized response (first 1000 chars):', cleanedResponse.substring(0, 1000));
            throw new Error('Failed to parse question from LLM response');
            
        } catch (error) {
            console.error('Error generating question:', error);
            throw error;
        }
    }

    /**
     * Generate multiple questions in a single LLM call (batch generation)
     * This significantly reduces API calls and rate limiting issues
     */
    async generateQuestionsBatch(company, role, questionCount, companyAbout, difficulty = 'medium') {
        // All questions should be of the specified difficulty
        const difficulties = Array(questionCount).fill(difficulty);
        const difficultyDesc = this.difficultyDescriptions[difficulty] || this.difficultyDescriptions['medium'];

        const prompt = `You are an expert technical interviewer creating ${questionCount} COMPREHENSIVE CODING Online Assessment questions with extensive test coverage.

**CRITICAL REQUIREMENTS - READ CAREFULLY:**
1. Generate EXACTLY ${questionCount} distinct ${difficulty.toUpperCase()} difficulty coding/programming questions
2. NO MCQs, NO theory questions - ONLY coding challenges
3. Each question MUST have EXACTLY 3 visible test cases (no more, no less)
4. Each question MUST have EXACTLY 5 hidden test cases
5. Each question MUST have EXACTLY 4 edge test cases
6. Total test cases per question: EXACTLY 12 cases

**Company:** ${company}
**Role:** ${role}
**Difficulty:** ${difficulty.toUpperCase()}
**Difficulty Focus:** ${difficultyDesc}
**About Company:** ${companyAbout}

Create ${questionCount} realistic ${difficulty.toUpperCase()}-difficulty CODING questions that:
1. Align with ${company}'s technical focus and the ${role} level
2. Focus on: ${difficultyDesc}
3. Require appropriate level of algorithmic thinking and problem-solving for ${difficulty} level
4. Each has EXACTLY 3 visible test cases showing the problem clearly
5. Each has EXACTLY 5 hidden test cases covering normal variations
6. Each has EXACTLY 4 edge test cases covering boundaries, extremes, special cases
7. Have clear constraints
8. Include "How to Approach" explanation
9. Include optimal solution code in Python
10. Estimated time: ${difficulty === 'easy' ? '20-25' : difficulty === 'medium' ? '25-35' : difficulty === 'hard' ? '35-45' : '45-60'} minutes per question

**TEST CASE REQUIREMENTS:**
- **Visible**: EXACTLY 3 test cases (simple, clear examples to understand the problem)
- **Hidden**: EXACTLY 5 test cases (normal scenarios, variations, different input sizes)
- **Edge**: EXACTLY 4 test cases (empty inputs, single elements, max values, min values)
- Cover key scenarios comprehensively
- Each test case MUST have distinct input and expected output as strings

**CRITICAL JSON FORMATTING RULES - MUST FOLLOW:**
- Return ONLY valid JSON, no markdown code blocks, no extra text
- Use double quotes for all JSON keys and string values
- For ALL string values (especially optimalSolution):
  * Escape ALL double quotes inside strings as \"
  * Escape ALL backslashes as \\
  * Replace actual newlines with \\n (two characters: backslash + n)
  * Do NOT include literal newline characters in JSON strings
  * Example: "def solution():\\n    return True"
- For test case inputs/outputs:
  * Keep ALL strings on a SINGLE LINE
  * Use compact array notation: [1,2,3]
  * Maximum 80 characters per input/output string
  * For arrays, use compact notation: "[1,2,3,4,5]"
  * For strings with quotes, escape them: "\"hello\""
  * NEVER split arrays or strings across multiple lines
- Number each test case sequentially: "1", "2", "3", etc.
- VALIDATE your JSON before returning - ensure it can be parsed

**IMPORTANT - Question Text Structure:**
- The "questionText" field should contain ONLY the problem statement/description
- DO NOT include examples, test cases, or step-by-step explanations in questionText
- Examples are shown separately from visibleTestcases - don't duplicate them in questionText
- Keep questionText focused: problem description, input/output format, basic requirements
- Use markdown formatting for readability (headers, bold, inline code)

**IMPORTANT - Optimal Solution Format:**
- Write clean, working Python code WITHOUT excessive comments
- Use proper Python indentation (4 spaces)
- Keep code concise and readable
- Escape ALL quotes and newlines properly for JSON
- Example format: "def solution(nums):\\n    # Brief comment\\n    return sum(nums)"

Return this exact JSON structure (an array of ${questionCount} questions):
{
  "questions": [
    {
      "questionId": "${company.toLowerCase()}-${role.toLowerCase().replace(/\s+/g, '-')}-topic1-medium",
      "questionText": "Complete problem description with clear examples and explanation",
      "constraints": ["Time limit: X seconds", "Memory limit: Y MB", "Input constraints..."],
      "visibleTestcases": {
        "1": {"input": "simple example input 1", "output": "expected output 1"},
        "2": {"input": "simple example input 2", "output": "expected output 2"},
        "3": {"input": "simple example input 3", "output": "expected output 3"}
      },
      "hiddenTestcases": {
        "1": {"input": "test 1", "output": "expected 1"},
        "2": {"input": "test 2", "output": "expected 2"},
        "3": {"input": "test 3", "output": "expected 3"},
        "4": {"input": "test 4", "output": "expected 4"},
        "5": {"input": "test 5", "output": "expected 5"}
      },
      "edgeTestcases": {
        "1": {"input": "empty/boundary case 1", "output": "expected 1"},
        "2": {"input": "extreme case 2", "output": "expected 2"},
        "3": {"input": "max value case 3", "output": "expected 3"},
        "4": {"input": "min value case 4", "output": "expected 4"}
      },
      "howToApproach": "Clear step-by-step approach explanation",
      "optimalSolution": "def solution():\\n    # Complete working Python code\\n    pass",
      "estimatedTime": 30,
      "difficulty": "medium",
      "role": "${role}",
      "company": "${company}"
    }
    ... (repeat for all ${questionCount} questions with DIFFERENT topics/algorithms)
  ]
}`;

        try {
            console.log(`🚀 Generating ${questionCount} questions in batch mode...`);
            const modelName = process.env.GEMINI_QUESTION_GEN_MODEL || 'gemini-2.0-flash';
            console.log(`📡 Using model: ${modelName}`);
            
            let data;
            try {
                data = await this.callGemini(prompt, modelName, 0.7, 2);
            } catch (apiError) {
                console.error('❌ callGemini threw an error:', apiError);
                throw apiError;
            }
            
            if (!data) {
                console.error('❌ callGemini returned null/undefined');
                throw new Error('No data returned from Gemini API');
            }
            
            console.log('📦 API response received, checking structure...');
            console.log('📦 data type:', typeof data);
            console.log('📦 data keys:', Object.keys(data || {}));
            console.log('📦 candidates exists:', !!data?.candidates);
            console.log('📦 candidates is array:', Array.isArray(data?.candidates));
            console.log('📦 candidates length:', data?.candidates?.length);
            
            if (!data?.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
                console.error('❌ No candidates in response!');
                console.error('❌ Full response:', JSON.stringify(data, null, 2));
                throw new Error('Invalid response structure: no candidates array');
            }
            
            const firstCandidate = data.candidates[0];
            console.log('📦 First candidate keys:', Object.keys(firstCandidate || {}));
            console.log('📦 content exists:', !!firstCandidate?.content);
            console.log('📦 parts exists:', !!firstCandidate?.content?.parts);
            console.log('📦 parts is array:', Array.isArray(firstCandidate?.content?.parts));
            
            const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            console.log(`🤖 Extracted text length: ${aiResponse.length} characters`);
            if (aiResponse.length === 0) {
                console.error('❌ Empty text in response!');
                console.error('❌ First candidate:', JSON.stringify(firstCandidate, null, 2));
                throw new Error('Empty response text from LLM');
            }
            console.log('🤖 First 500 chars:', aiResponse.substring(0, 500));
            console.log('🤖 Last 500 chars:', aiResponse.substring(Math.max(0, aiResponse.length - 500)));
            
            // Sanitize the response first
            const sanitizedResponse = this.sanitizeJSONString(aiResponse);
            console.log(`🧹 Sanitized response length: ${sanitizedResponse.length} characters`);
            
            // Remove markdown code blocks if present
            let cleanedResponse = sanitizedResponse.trim();
            if (cleanedResponse.startsWith('```json')) {
                cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/```\s*$/, '');
            } else if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/```\s*$/, '');
            }
            
            // Pre-process to fix code fields BEFORE parsing
            console.log('🔧 Pre-processing code fields...');
            cleanedResponse = this.fixCodeFieldsBeforeParse(cleanedResponse);
            
            // Try robust extraction
            let result = this.extractFirstBalancedJSON(cleanedResponse);
            
            // Fallback to regex
            if (!result) {
                const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const sanitizedMatch = this.sanitizeJSONString(jsonMatch[0]);
                    try {
                        result = JSON.parse(sanitizedMatch);
                    } catch (parseError) {
                        console.error('❌ Initial JSON parse error:', parseError.message);
                        console.error('❌ Error at position:', parseError.message.match(/position (\d+)/)?.[1]);
                        
                        // Try one more time with aggressive cleaning
                        try {
                            const aggressiveCleaned = this.aggressiveJSONClean(sanitizedMatch);
                            result = JSON.parse(aggressiveCleaned);
                            console.log('✅ Aggressive cleaning succeeded!');
                        } catch (finalError) {
                            console.error('❌ Final JSON parse error:', finalError.message);
                            console.error('❌ Failed JSON (first 1000 chars):', sanitizedMatch.substring(0, 1000));
                            console.error('❌ Failed JSON (last 1000 chars):', sanitizedMatch.substring(Math.max(0, sanitizedMatch.length - 1000)));
                            result = null;
                        }
                    }
                }
            }
            
            // If we successfully parsed, fix any code fields that might have issues
            if (result && result.questions && Array.isArray(result.questions)) {
                console.log('🔧 Applying code field fixes...');
                result.questions = result.questions.map(q => this.fixCodeFieldsInJSON(q));
            }
            
            if (result && result.questions && Array.isArray(result.questions)) {
                console.log(`✅ Successfully parsed ${result.questions.length} questions in batch`);
                
                // Log test case counts for each question
                result.questions.forEach((q, idx) => {
                    const visibleCount = q.visibleTestcases ? Object.keys(q.visibleTestcases).length : 0;
                    const hiddenCount = q.hiddenTestcases ? Object.keys(q.hiddenTestcases).length : 0;
                    const edgeCount = q.edgeTestcases ? Object.keys(q.edgeTestcases).length : 0;
                    console.log(`📊 Question ${idx + 1} (${q.questionId}): ${visibleCount} visible, ${hiddenCount} hidden, ${edgeCount} edge (Total: ${visibleCount + hiddenCount + edgeCount})`);
                });
                
                return result.questions;
            }
            
            console.error('❌ Failed to extract questions array from batch response');
            console.error('❌ Response structure check:');
            console.error('   - result exists:', !!result);
            console.error('   - result.questions exists:', !!(result && result.questions));
            console.error('   - result.questions is array:', !!(result && result.questions && Array.isArray(result.questions)));
            if (result) {
                console.error('   - result keys:', Object.keys(result));
            }
            throw new Error('Failed to parse batch questions from LLM response');
            
        } catch (error) {
            console.error('❌ Error generating questions in batch:', error.message);
            console.log('⚠️  Falling back to sequential generation...');
            
            // Fallback: generate questions one by one
            const questions = [];
            for (let i = 0; i < questionCount; i++) {
                const difficulty = difficulties[i];
                console.log(`📝 Generating question ${i + 1}/${questionCount} (${difficulty})...`);
                try {
                    const question = await this.generateQuestion(company, role, difficulty, companyAbout);
                    questions.push(question);
                    // Add small delay between fallback calls
                    if (i < questionCount - 1) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                } catch (err) {
                    console.error(`Failed to generate question ${i + 1}:`, err);
                    throw new Error(`Failed to generate question ${i + 1}: ${err.message}`);
                }
            }
            return questions;
        }
    }

}

export default new OAScoringService();

