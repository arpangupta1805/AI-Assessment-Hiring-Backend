
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Convert import.meta.url to __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

import CandidateAssessment from '../models/CandidateAssessment.js';
import AssessmentSet from '../models/AssessmentSet.js';
import AssessmentAnswer from '../models/AssessmentAnswer.js';
import JobDescription from '../models/JobDescription.js';
import User from '../models/User.js';

async function debugData() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        // Get the most recent submitted candidate
        const candidateAssessment = await CandidateAssessment.findOne({ status: { $in: ['submitted', 'evaluating', 'evaluated', 'decided'] } })
            .sort({ createdAt: -1 })
            .populate('assignedSet');

        if (!candidateAssessment) {
            console.log('No recent candidate found.');
            return;
        }

        console.log(`\nAnalyzing Candidate: ${candidateAssessment._id}`);
        console.log(`Status: ${candidateAssessment.status}`);

        const set = candidateAssessment.assignedSet;
        if (!set) {
            console.error('❌ No assigned set found!');
            return;
        }
        console.log(`Assessment Set ID: ${set._id}`);

        // Check Objective Questions
        console.log(`\n--- Objective Questions in Set (${set.objectiveQuestions.length}) ---`);
        let setHasCorrectOptions = false;
        set.objectiveQuestions.slice(0, 3).forEach((q, i) => {
            const correctOpt = q.options.find(o => o.isCorrect);
            if (correctOpt) setHasCorrectOptions = true;
            console.log(`Q[${i}] ${q.questionId}: Points=${q.points}, Correct Option: ${correctOpt ? 'YES' : 'NO'}`);
        });

        // Check Resume Data
        console.log(`\n--- Resume Data ---`);
        if (candidateAssessment.resume) {
            console.log('Resume Match Score:', candidateAssessment.resume.matchScore);
            console.log('Resume Analysis:', JSON.stringify(candidateAssessment.resume.matchAnalysis, null, 2));
        } else {
            console.log('❌ No resume data found');
        }

        // Get Answers
        const answerDoc = await AssessmentAnswer.findOne({
            candidateAssessment: candidateAssessment._id,
            section: 'objective'
        });

        if (!answerDoc) {
            console.log('\n❌ No objective answers found for this candidate.');
        } else {
            console.log(`\n--- Objective Answers (${answerDoc.objectiveAnswers.length}) ---`);
            answerDoc.objectiveAnswers.forEach((ans, i) => {
                const question = set.objectiveQuestions.find(q => q.questionId === ans.questionId);
                let isActuallyCorrect = false;
                let details = 'Question not found in set';

                if (question) {
                    const selectedOpt = question.options[ans.selectedOptionIndex];
                    isActuallyCorrect = selectedOpt && selectedOpt.isCorrect;
                    details = `Selected Idx: ${ans.selectedOptionIndex}, IsCorrect (DB): ${ans.isCorrect}, Calculated: ${isActuallyCorrect}`;
                }

                console.log(`A[${i}] ${ans.questionId}: ${details}`);
            });
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
    }
}

debugData();
