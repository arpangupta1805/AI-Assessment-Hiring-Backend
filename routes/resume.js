import express from 'express';
import Resume from '../models/Resume.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// GET /api/resume - Get all resumes for the authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;

    const resumes = await Resume.find({ username }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: resumes.map(resume => ({
        id: resume._id,
        title: resume.title,
        resumeText: resume.resumeText,
        createdAt: resume.createdAt,
        updatedAt: resume.updatedAt,
        questionBankCounts: {
          easy: resume.arrofQuestionbankids?.get('arrofeasyquestionbankids')?.length || 0,
          medium: resume.arrofQuestionbankids?.get('arrofoMediumquestionbankids')?.length || 0,
          hard: resume.arrofQuestionbankids?.get('arrofoHardquestionbankids')?.length || 0,
        },
      })),
    });
  } catch (error) {
    console.error('❌ Error fetching resumes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch resumes',
      message: error.message,
    });
  }
});

// GET /api/resume/:id - Get single resume by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const resume = await Resume.findById(req.params.id);
    
    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found',
      });
    }

    // Verify ownership
    if (resume.username !== username) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    res.json({
      success: true,
      data: {
        id: resume._id,
        title: resume.title,
        resumeText: resume.resumeText,
        arrofQuestionbankids: resume.arrofQuestionbankids,
        createdAt: resume.createdAt,
        updatedAt: resume.updatedAt,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching resume:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch resume',
      message: error.message,
    });
  }
});

// POST /api/resume - Create new resume
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, resumeText } = req.body;
    const username = req.user.username;

    // Validation
    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Resume title is required',
      });
    }

    if (!resumeText || !resumeText.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Resume text is required',
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('📝 CREATING RESUME');
    console.log('='.repeat(80));
    console.log('Username:', username);
    console.log('Title:', title);
    console.log('Resume Text Length:', resumeText.length, 'characters');
    console.log('-'.repeat(80));

    // Append suffix ' (Resume)' if missing
    let storedTitle = title.trim();
    if (!storedTitle.endsWith(' (Resume)')) {
      storedTitle = `${storedTitle} (Resume)`;
    }

    // Create new resume
    const resume = await Resume.create({
      username,
      title: storedTitle,
      resumeText: resumeText.trim(),
      arrofQuestionbankids: new Map([
        ['arrofeasyquestionbankids', []],
        ['arrofoMediumquestionbankids', []],
        ['arrofoHardquestionbankids', []],
        ['arrofoExpertquestionbankids', []],
      ]),
    });

    console.log(`✅ Resume created (ID: ${resume._id})`);
    console.log('='.repeat(80) + '\n');

    res.status(201).json({
      success: true,
      message: 'Resume created successfully',
      data: {
        id: resume._id,
        title: resume.title,
        resumeText: resume.resumeText,
        createdAt: resume.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Error creating resume:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create resume',
      message: error.message,
    });
  }
});

// PUT /api/resume/:id - Update resume
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, resumeText } = req.body;
    const username = req.user.username;

    const resume = await Resume.findById(req.params.id);
    
    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found',
      });
    }

    // Verify ownership
    if (resume.username !== username) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    // Update fields
    if (title) resume.title = title.trim();
    if (resumeText) resume.resumeText = resumeText.trim();

    await resume.save();

    console.log(`✅ Resume updated (ID: ${resume._id})`);

    res.json({
      success: true,
      message: 'Resume updated successfully',
      data: {
        id: resume._id,
        title: resume.title,
        resumeText: resume.resumeText,
        updatedAt: resume.updatedAt,
      },
    });
  } catch (error) {
    console.error('❌ Error updating resume:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update resume',
      message: error.message,
    });
  }
});

// DELETE /api/resume/:id - Delete resume
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const resume = await Resume.findById(req.params.id);
    
    if (!resume) {
      return res.status(404).json({
        success: false,
        error: 'Resume not found',
      });
    }

    // Verify ownership
    if (resume.username !== username) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      });
    }

    await Resume.findByIdAndDelete(req.params.id);

    console.log(`✅ Resume deleted (ID: ${req.params.id})`);

    res.json({
      success: true,
      message: 'Resume deleted successfully',
    });
  } catch (error) {
    console.error('❌ Error deleting resume:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete resume',
      message: error.message,
    });
  }
});

export default router;




