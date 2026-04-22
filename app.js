import 'dotenv/config'
import express from 'express';
import cors from 'cors'
import { verifyToken } from './middleware/verifyToken.js';
import authRoute from './routes/auth.js'
import profileRoute from './routes/profile.js'
import projectRoute from './routes/projects.js'
import taskRoute from './routes/task.js'
import subtaskRoute from './routes/subtasks.js'
import outputRoute from './routes/output.js'
import driveAPI from './middleware/upload-to-drive.js'
import designRoute from './routes/design.js'
import usersInfoRoute from './routes/users_info.js'
import posRoleRoute from './routes/positions.js'
import notifRoute from './routes/notifications.js'
import reportRoute from './routes/accomplishment_report.js'
const app = express();
const PORT = 3000;

// Add rate limiter next

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

app.use(express.json({ limit: '3mb' })); // Increase from default 100kb
app.use(express.urlencoded({ limit: '3mb', extended: true }));

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    // if (!origin) return callback(null, true);
    
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

// Use verifyToken for actions that requires user authentication
// Express only uses Anon Key so it requires session_token to conduct transactions

app.use('/auth', authRoute)
app.use('/profile', verifyToken, profileRoute)
app.use('/ppa', verifyToken, projectRoute)
app.use('/tasks', verifyToken, taskRoute)
app.use('/subtasks', verifyToken, subtaskRoute)
app.use('/output', verifyToken, outputRoute)
app.all('/api/upload-to-drive', verifyToken, driveAPI)
app.use('/design', verifyToken, designRoute)
app.use('/users_info', verifyToken, usersInfoRoute)
app.use('/office', verifyToken, posRoleRoute)
app.use('/notifications', verifyToken, notifRoute)
app.use('/report', verifyToken, reportRoute)

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
