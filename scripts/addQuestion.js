#!/usr/bin/env node

/**
 * Interactive CLI Script to Add Questions to OAQuestions Database
 * Run with: node addQuestion.js
 */

import readline from 'readline';
import mongoose from 'mongoose';
import OAquestions from '../models/oaquestions.js';
import dotenv from 'dotenv';

dotenv.config();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const question = (prompt) => new Promise((resolve) => {
    rl.question(prompt, (answer) => {
        resolve(answer);
    });
});

const parseTestCases = (input) => {
    const testCases = {};
    const lines = input.split('\n').filter(l => l.trim());
    
    if (lines.length === 0) return testCases;
    
    // Assume format: input1 | output1
    // input2 | output2
    let caseNum = 1;
    for (const line of lines) {
        const [input, output] = line.split('|').map(s => s.trim());
        if (input && output) {
            testCases[`case_${caseNum}`] = {
                input: input,
                output: output,
            };
            caseNum++;
        }
    }
    
    return testCases;
};

const main = async () => {
    try {
        console.log('\n📝 === OA Question Addition Tool ===\n');
        
        // Connect to database
        const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/oa_interview';
        console.log(`🔗 Connecting to MongoDB: ${mongoUrl}`);
        await mongoose.connect(mongoUrl);
        console.log('✅ Connected to MongoDB\n');

        // Collect question details
        const questionId = await question('Question ID (unique, e.g., Q001): ');
        const questionText = await question('Question Description: ');
        
        console.log('\n🏆 Difficulty Levels: easy, medium, hard, expert');
        const difficulty = await question('Difficulty Level: ');
        
        console.log('\n👤 Available Roles: SDE 1, SDE 2, SDE 3');
        const role = await question('Role: ');
        
        const company = await question('Company Name: ');
        const estimatedTime = parseInt(await question('Estimated Time (minutes): '));
        
        const constraints = await question('Constraints (comma-separated): ');
        const constraintsArray = constraints.split(',').map(c => c.trim()).filter(c => c);

        const howToApproach = await question('\nHow to Approach (approach explanation): ');
        const solution = await question('Solution Code: ');
        const optimalSolution = await question('Optimal Solution Code: ');

        console.log('\n📋 Test Cases Format: input1 | output1 (one per line)');
        console.log('Example:');
        console.log('5 | 120');
        console.log('10 | 3628800\n');

        const visibleInput = await question('Visible Test Cases (input | output): ');
        const visibleTestcases = parseTestCases(visibleInput);

        const hiddenInput = await question('Hidden Test Cases (input | output): ');
        const hiddenTestcases = parseTestCases(hiddenInput);

        const edgeInput = await question('Edge Test Cases (input | output): ');
        const edgeTestcases = parseTestCases(edgeInput);

        // Create question document
        const newQuestion = new OAquestions({
            questionid: questionId,
            questiontxt: questionText,
            difficulty: difficulty.toLowerCase(),
            role,
            company,
            estimated_time: estimatedTime,
            constraints: constraintsArray,
            howtoapproach: howToApproach,
            solution,
            optimal_solution: optimalSolution,
            visible_testcases: visibleTestcases,
            hidden_testcases: hiddenTestcases,
            edge_testcases: edgeTestcases,
        });

        // Save to database
        await newQuestion.save();
        console.log('\n✅ Question added successfully!');
        console.log(`📌 Question ID: ${questionId}`);
        console.log(`📊 Visible: ${Object.keys(visibleTestcases).length} | Hidden: ${Object.keys(hiddenTestcases).length} | Edge: ${Object.keys(edgeTestcases).length}`);

        // Ask if user wants to add another
        const addAnother = await question('\nAdd another question? (yes/no): ');
        if (addAnother.toLowerCase() === 'yes' || addAnother.toLowerCase() === 'y') {
            rl.close();
            const { spawn } = await import('child_process');
            spawn('node', [import.meta.url], { stdio: 'inherit' });
        } else {
            console.log('\n👋 Goodbye!\n');
            process.exit(0);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Details:', error);
        process.exit(1);
    } finally {
        rl.close();
        await mongoose.disconnect();
    }
};

main();
