#!/usr/bin/env node

/**
 * Add Questions from JSON File
 * Run with: node addQuestionFromJSON.js path/to/questions.json
 * 
 * Expected JSON format:
 * {
 *   "questions": [
 *     {
 *       "questionid": "Q001",
 *       "questiontxt": "...",
 *       "difficulty": "easy",
 *       "role": "SDE 1",
 *       "company": "Google",
 *       "estimated_time": 30,
 *       "constraints": ["1 <= n <= 1000"],
 *       "howtoapproach": "...",
 *       "optimal_solution": "...",
 *       "visible_testcases": {
 *         "case_1": { "input": "5", "output": "120" }
 *       },
 *       "hidden_testcases": {},
 *       "edge_testcases": {}
 *     }
 *   ]
 * }
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import OAquestions from '../models/oaquestions.js';
import dotenv from 'dotenv';

dotenv.config();

const main = async () => {
    const filePath = process.argv[2];

    if (!filePath) {
        console.log('❌ Please provide a JSON file path');
        console.log('Usage: node addQuestionFromJSON.js path/to/questions.json');
        process.exit(1);
    }

    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            console.log(`❌ File not found: ${filePath}`);
            process.exit(1);
        }

        // Read and parse JSON
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(fileContent);

        if (!data.questions || !Array.isArray(data.questions)) {
            console.log('❌ Invalid JSON format. Expected { "questions": [...] }');
            process.exit(1);
        }

        // Connect to MongoDB
        const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/oa_interview';
        console.log(`\n🔗 Connecting to MongoDB...`);
        await mongoose.connect(mongoUrl);
        console.log('✅ Connected\n');

        let successCount = 0;
        let errorCount = 0;

        // Process each question
        for (const qData of data.questions) {
            try {
                // Validate required fields
                const required = ['questionid', 'questiontxt', 'difficulty', 'role', 'company', 'estimated_time'];
                const missing = required.filter(f => !qData[f]);

                if (missing.length > 0) {
                    console.log(`⚠️  Skipping ${qData.questionid || 'unknown'}: Missing fields: ${missing.join(', ')}`);
                    errorCount++;
                    continue;
                }

                // Create question
                const newQuestion = new OAquestions({
                    questionid: qData.questionid,
                    questiontxt: qData.questiontxt,
                    difficulty: qData.difficulty.toLowerCase(),
                    role: qData.role,
                    company: qData.company,
                    estimated_time: qData.estimated_time,
                    constraints: qData.constraints || [],
                    howtoapproach: qData.howtoapproach || '',
                    optimal_solution: qData.optimal_solution || '',
                    visible_testcases: qData.visible_testcases || {},
                    hidden_testcases: qData.hidden_testcases || {},
                    edge_testcases: qData.edge_testcases || {},
                });

                await newQuestion.save();
                console.log(`✅ Added: ${qData.questionid} (${qData.company} - ${qData.role})`);
                successCount++;

            } catch (error) {
                if (error.code === 11000) {
                    console.log(`⚠️  Duplicate: ${qData.questionid} already exists`);
                } else {
                    console.log(`❌ Error adding ${qData.questionid}: ${error.message}`);
                }
                errorCount++;
            }
        }

        console.log(`\n📊 Results: ✅ ${successCount} added, ❌ ${errorCount} failed\n`);
        process.exit(0);

    } catch (error) {
        console.error('❌ Fatal Error:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }
};

main();
