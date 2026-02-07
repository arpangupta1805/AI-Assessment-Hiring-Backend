import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import connectDB from './config/db.js';

// Route imports
import authRouter from './routes/auth.js';
import userRouter from './routes/user.js';
import jdRouter from './routes/jd.js';
import candidateRouter from './routes/candidate.js';
import assessmentRouter from './routes/assessment-execution.js';
import codeRouter from './routes/code.js';
import evaluationRouter from './routes/evaluation.js';
import adminRouter from './routes/admin.js';
import emailRouter from './routes/email.js';

// Services
import emailService from './services/emailService.js';
import EmailTemplate from './models/EmailTemplate.js';

// ES Module path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Middleware - Allow multiple origins
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3000', 'https://ai-hiring-assessment-frontend.vercel.app'];

console.log('🔧 Allowed CORS origins:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.some(allowed => origin === allowed)) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked for:', origin, 'Allowed origins:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' })); // Increased limit for base64 images
app.use(express.urlencoded({ extended: true }));

// Serve static files from /uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Connect to MongoDB
connectDB().then(() => {
  // Seed email templates
  EmailTemplate.seedDefaults()
    .then(() => console.log('📧 Email templates seeded'))
    .catch(err => console.error('❌ Failed to seed email templates:', err));
});

// Initialize services
emailService.init();

// =============================================================================
// ROUTES
// =============================================================================

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🚀 AI Hiring & Assessment Platform API',
    version: '2.0.0',
    status: 'Running',
    endpoints: {
      auth: '/api/auth (signup, login, verify, OTP)',
      jd: '/api/jd (job descriptions, AI parsing, assessment config)',
      candidate: '/api/candidate (onboarding, resume matching)',
      assessment: '/api/assessment (execution, answers, proctoring)',
      code: '/api/code (run, submit programming tests)',
      eval: '/api/eval (evaluation, scoring)',
      admin: '/api/admin (dashboard, analytics)',
      email: '/api/email (templates, send)',
      health: '/health',
    },
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: 'Connected',
    version: '2.0.0',
  });
});

// Auth routes (signup, login, OTP, verify)
app.use('/api/auth', authRouter);

// User routes (profile)
app.use('/api/user', userRouter);

// Job Description routes (CRUD, AI parsing, config)
app.use('/api/jd', jdRouter);

// Candidate routes (onboarding, resume upload)
app.use('/api/candidate', candidateRouter);

// Assessment execution routes (session, questions, answers)
app.use('/api/assessment', assessmentRouter);

// Code execution routes (run, submit)
app.use('/api/code', codeRouter);

// Evaluation routes (trigger, result, decision)
app.use('/api/eval', evaluationRouter);

// Admin dashboard routes (candidates, proctoring, analytics)
app.use('/api/admin', adminRouter);

// Email routes (templates, send)
app.use('/api/email', emailRouter);

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  res.status(500).json({
    success: false,
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const PORT = process.env.PORT || 5002;
app.listen(PORT, () => {
  console.log('\n🚀 Server Started Successfully!');
  console.log(`📡 Server running on: http://localhost:${PORT}`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Auth endpoints: http://localhost:${PORT}/api/auth`);
  console.log(`📋 JD endpoints: http://localhost:${PORT}/api/jd`);
  console.log(`👤 Candidate endpoints: http://localhost:${PORT}/api/candidate`);
  console.log(`📝 Assessment endpoints: http://localhost:${PORT}/api/assessment`);
  console.log(`💻 Code endpoints: http://localhost:${PORT}/api/code`);
  console.log(`✅ Evaluation endpoints: http://localhost:${PORT}/api/eval`);
  console.log(`⚙️  Admin endpoints: http://localhost:${PORT}/api/admin`);
});
