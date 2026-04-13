// index.js
import express from 'express';
import cors from 'cors'
import { verifyToken } from './middleware/verifyToken.js';
import authRoute from './routes/auth.js'
import profileRoute from './routes/profile.js'
import projectRoute from './routes/projects.js'
import taskRoute from './routes/task.js'
import subtaskRoute from './routes/subtasks.js'
const app = express();
const PORT = 3000;

const allowedOrigins = [
  'http://localhost:5173', // Local Vue dev port
  'https://oarchestrate.vercel.app',
  /\.vercel\.app$/ // This regex allows all Vercel preview deployments
];

// app.use((req, res, next) => {
//   console.log(`[${req.method}] ${req.path}`);
//   console.log('Content-Type:', req.headers['content-type']);
//   console.log('Body Status:', req.body ? 'Populated' : 'UNDEFINED');
//   next();
// });

app.use(express.json({ limit: '5mb' })); // Increase from default 100kb
app.use(express.urlencoded({ limit: '5mb', extended: true }));

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const isAllowed = allowedOrigins.some(allowed => {
      return allowed instanceof RegExp ? allowed.test(origin) : allowed === origin;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use('/auth', authRoute)
app.use('/profile', verifyToken, profileRoute)
app.use('/ppa', verifyToken, projectRoute)
app.use('/tasks', verifyToken, taskRoute)
app.use('/subtasks', verifyToken, subtaskRoute)

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
