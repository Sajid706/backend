const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
console.log("MONGO_URI:", process.env.MONGO_URI);
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

// ─── Schemas ──────────────────────────────────────────────────────────────────
const candidateSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  role: String,
  skills: [String],
  score: Number,
  status: { type: String, enum: ['shortlisted', 'rejected'], default: 'rejected' },
  examToken: String,
  examCompleted: { type: Boolean, default: false },
  examScore: Number,
  examPassed: Boolean,
  proctorFlags: [{ type: String, timestamp: Date }],
  appliedAt: { type: Date, default: Date.now },
});

const Candidate = mongoose.model('Candidate', candidateSchema);

const examResultSchema = new mongoose.Schema({
  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate' },
  role: String,
  mcqAnswers: Object,
  codingAnswers: Object,
  mcqScore: Number,
  codingScore: Number,
  totalScore: Number,
  passed: Boolean,
  proctorEvents: [Object],
  submittedAt: { type: Date, default: Date.now },
});
const ExamResult = mongoose.model('ExamResult', examResultSchema);

// ─── Role Keywords ────────────────────────────────────────────────────────────
const ROLE_KEYWORDS = {
  'Full Stack Engineer': {
    required: ['react', 'node', '.net', 'javascript', 'typescript', 'sql', 'api', 'html', 'css'],
    bonus: ['azure', 'docker', 'redis', 'mongodb', 'graphql', 'nextjs'],
    threshold: 60,
  },
  'Platform Engineer': {
    required: ['kubernetes', 'docker', 'devops', 'ci/cd', 'linux', 'terraform', 'ansible'],
    bonus: ['azure', 'aws', 'gcp', 'helm', 'prometheus', 'jenkins'],
    threshold: 60,
  },
  'AI Engineer': {
    required: ['python', 'llm', 'rag', 'langchain', 'openai', 'machine learning', 'pytorch'],
    bonus: ['azure ai', 'huggingface', 'vector db', 'mlflow', 'fastapi'],
    threshold: 60,
  },
  'AI Architect': {
    required: ['architecture', 'machine learning', 'deep learning', 'mlops', 'system design'],
    bonus: ['llm', 'transformers', 'distributed systems', 'azure', 'cloud native'],
    threshold: 65,
  },
};

// ─── Resume Scoring ───────────────────────────────────────────────────────────
function scoreResume(text, role) {
  const lower = text.toLowerCase();
  const keywords = ROLE_KEYWORDS[role];
  if (!keywords) return 0;

  let score = 0;
  let matched = [];

  keywords.required.forEach(kw => {
    if (lower.includes(kw)) { score += 7; matched.push(kw); }
  });
  keywords.bonus.forEach(kw => {
    if (lower.includes(kw)) { score += 4; matched.push(kw); }
  });

  // Experience boost
  const expMatch = lower.match(/(\d+)\+?\s*years?/);
  if (expMatch) {
    const years = parseInt(expMatch[1]);
    if (years >= 5) score += 10;
    else if (years >= 3) score += 7;
    else if (years >= 1) score += 4;
  }

  return Math.min(score, 100);
}

function extractInfo(text) {
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/(\+91|0)?[\s-]?[6-9]\d{9}/);
  const lines = text.split('\n').filter(l => l.trim());
  const name = lines[0]?.trim() || 'Candidate';

  const skillKeywords = ['javascript','python','react','node','java','c#','.net','docker',
    'kubernetes','azure','aws','sql','mongodb','typescript','django','fastapi','pytorch',
    'tensorflow','langchain','llm','rag','devops','terraform','ansible','helm','linux'];
  const lower = text.toLowerCase();
  const skills = skillKeywords.filter(s => lower.includes(s));

  return {
    name,
    email: emailMatch?.[0] || '',
    phone: phoneMatch?.[0] || '',
    skills,
  };
}

// ─── Email Transporter ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendShortlistEmail(candidate, examLink) {
  await transporter.sendMail({
    from: `"HR Team" <${process.env.EMAIL_USER}>`,
    to: candidate.email,
    subject: `Congratulations! You are shortlisted for ${candidate.role}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 30px; border-radius: 10px 10px 0 0;">
          <h1 style="margin:0; color: #00d4ff;">🎉 Congratulations!</h1>
        </div>
        <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 10px 10px;">
          <p>Dear <strong>${candidate.name}</strong>,</p>
          <p>We are pleased to inform you that your profile has been shortlisted for the <strong>${candidate.role}</strong> position.</p>
          <p>Your skills in <strong>${candidate.skills.slice(0,5).join(', ')}</strong> impressed us!</p>
          <div style="background: #e8f4ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #1a1a2e; margin-top:0;">📝 Next Step: Online Exam</h3>
            <p>You must complete a <strong>45-minute proctored exam</strong> (MCQ + Coding).</p>
            <ul>
              <li>20 MCQ questions (role-specific)</li>
              <li>3 Coding challenges</li>
              <li>Camera required (AI proctored)</li>
              <li>No tab switching allowed</li>
            </ul>
            <a href="${examLink}" style="display:inline-block; background:#00d4ff; color:#000; padding:14px 28px; text-decoration:none; border-radius:6px; font-weight:bold; margin-top:10px;">
              ▶ Start Your Exam
            </a>
          </div>
          <p style="color:#888; font-size:13px;">This exam link is unique to you and can only be used once. Valid for 72 hours.</p>
        </div>
      </div>
    `,
  });
}

async function sendRejectionEmail(candidate) {
  await transporter.sendMail({
    from: `"HR Team" <${process.env.EMAIL_USER}>`,
    to: candidate.email,
    subject: `Application Update - ${candidate.role}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #2d2d2d; color: white; padding: 30px; border-radius: 10px 10px 0 0;">
          <h1 style="margin:0;">Application Update</h1>
        </div>
        <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 10px 10px;">
          <p>Dear <strong>${candidate.name}</strong>,</p>
          <p>Thank you for your interest in the <strong>${candidate.role}</strong> position.</p>
          <p>After careful review, we regret to inform you that your profile does not match our current requirements at this time.</p>
          <p>We encourage you to strengthen your skills in: <strong>${Object.values(ROLE_KEYWORDS).find(r => true)?.required?.slice(0,3).join(', ')}</strong> and apply again in the future.</p>
          <p>We wish you the very best in your job search!</p>
          <p>Warm regards,<br><strong>HR Team</strong></p>
        </div>
      </div>
    `,
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Bulk CV Upload
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 500 } });

app.post('/api/upload-resumes', upload.array('resumes'), async (req, res) => {
  const { role } = req.body;
  if (!role || !ROLE_KEYWORDS[role]) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const results = { total: 0, shortlisted: 0, rejected: 0, errors: 0 };
  const processed = [];

  for (const file of req.files) {
    try {
      const data = await pdfParse(file.buffer);
      const text = data.text;
      const info = extractInfo(text);
      const score = scoreResume(text, role);
      const keywords = ROLE_KEYWORDS[role];
      const status = score >= keywords.threshold ? 'shortlisted' : 'rejected';

      const examToken = status === 'shortlisted' ? crypto.randomBytes(32).toString('hex') : null;

      const candidate = await Candidate.create({
        ...info,
        role,
        score,
        status,
        examToken,
      });

      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

      if (status === 'shortlisted' && info.email) {
        const examLink = `${baseUrl}/exam/${examToken}`;
        await sendShortlistEmail(candidate, examLink);
        results.shortlisted++;
      } else if (status === 'rejected' && info.email) {
        await sendRejectionEmail(candidate);
        results.rejected++;
      }

      processed.push({ name: info.name, email: info.email, score, status });
      results.total++;
    } catch (err) {
      results.errors++;
    }
  }

  res.json({ ...results, candidates: processed });
});

// Get all candidates (HR dashboard)
app.get('/api/candidates', async (req, res) => {
  const { role, status } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (status) filter.status = status;
  const candidates = await Candidate.find(filter).sort({ score: -1 });
  res.json(candidates);
});

// Validate exam token
app.get('/api/exam/:token', async (req, res) => {
  const candidate = await Candidate.findOne({ examToken: req.params.token });
  if (!candidate) return res.status(404).json({ error: 'Invalid or expired exam link' });
  if (candidate.examCompleted) return res.status(403).json({ error: 'Exam already completed' });
  res.json({ candidateId: candidate._id, name: candidate.name, role: candidate.role });
});

// Submit exam
app.post('/api/exam/:token/submit', async (req, res) => {
  const candidate = await Candidate.findOne({ examToken: req.params.token });
  if (!candidate) return res.status(404).json({ error: 'Invalid token' });
  if (candidate.examCompleted) return res.status(403).json({ error: 'Already submitted' });

  const { mcqAnswers, codingAnswers, proctorEvents, mcqScore, aiCodingScore } = req.body;

  const totalScore = Math.round((mcqScore * 0.4) + (aiCodingScore * 0.6));
  const passed = totalScore >= 65;

  await ExamResult.create({
    candidateId: candidate._id,
    role: candidate.role,
    mcqAnswers,
    codingAnswers,
    mcqScore,
    codingScore: aiCodingScore,
    totalScore,
    passed,
    proctorEvents,
  });

  candidate.examCompleted = true;
  candidate.examScore = totalScore;
  candidate.examPassed = passed;
  await candidate.save();

  res.json({ totalScore, passed, message: passed ? 'Congratulations! You passed.' : 'Thank you for attempting.' });
});

// HR Dashboard stats
app.get('/api/dashboard', async (req, res) => {
  const total = await Candidate.countDocuments();
  const shortlisted = await Candidate.countDocuments({ status: 'shortlisted' });
  const rejected = await Candidate.countDocuments({ status: 'rejected' });
  const examCompleted = await Candidate.countDocuments({ examCompleted: true });
  const examPassed = await Candidate.countDocuments({ examPassed: true });
  const byRole = await Candidate.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);

  res.json({ total, shortlisted, rejected, examCompleted, examPassed, byRole });
});

app.listen(5000, () => console.log('HR System backend running on port 5000'));
