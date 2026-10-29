import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';

const backendDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(backendDirectory, '..');
dotenv.config({ path: resolve(projectDirectory, '.env') });

const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number.');
}
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in .env.');
}

const databasePath = resolve(projectDirectory, process.env.DATABASE_PATH || './data/teamflow.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(readFileSync(resolve(backendDirectory, 'schema.sql'), 'utf8'));

function runTransaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = database.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        database.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const expiresAt = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      database.prepare(`
        INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(sessionData), expiresAt);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }

  touch(sid, sessionData, callback) {
    try {
      const expiresAt = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      database.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }

  destroy(sid, callback) {
    try {
      database.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'teamflow.sid',
  secret: sessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function requireAuthentication(request, response, next) {
  if (!request.session.userId) {
    return response.status(401).json({ error: 'Please sign in to continue.' });
  }
  return next();
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateWorkspace(value) {
  if (!value || !Array.isArray(value.members) || !Array.isArray(value.projects) || !Array.isArray(value.tasks)) {
    throw new Error('Workspace must include members, projects, and tasks.');
  }
  if (value.members.length > 200 || value.projects.length > 500 || value.tasks.length > 5000) {
    throw new Error('Workspace has too many records.');
  }

  const cleanText = (item, field, maxLength, required = false) => {
    if (typeof item !== 'string') throw new Error(`${field} must be text.`);
    const text = item.trim();
    if (text.length > maxLength || (required && !text)) throw new Error(`${field} is invalid.`);
    return text;
  };
  const members = value.members.map(member => ({
    id: cleanText(member?.id, 'Member ID', 100, true),
    name: cleanText(member?.name, 'Member name', 50, true),
    email: cleanText(member?.email ?? '', 'Member email', 100),
    isSelf: member?.id === 'you'
  }));
  if (new Set(members.map(member => member.id)).size !== members.length || !members.some(member => member.id === 'you')) {
    throw new Error('Workspace must contain exactly one owner named "you".');
  }
  const memberIds = new Set(members.map(member => member.id));

  const projects = value.projects.map(project => {
    if (!Array.isArray(project?.members)) throw new Error('Project members must be a list.');
    const projectMembers = [...new Set(project.members.map(id => cleanText(id, 'Project member ID', 100, true)))];
    if (projectMembers.some(id => !memberIds.has(id))) throw new Error('Project references a missing member.');
    return {
      id: cleanText(project?.id, 'Project ID', 100, true),
      name: cleanText(project?.name, 'Project name', 70, true),
      course: cleanText(project?.course ?? '', 'Course', 50),
      description: cleanText(project?.description ?? '', 'Description', 240),
      deadline: cleanText(project?.deadline ?? '', 'Deadline', 10),
      owner: cleanText(project?.owner ?? 'You', 'Owner', 50, true),
      members: projectMembers
    };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) {
    throw new Error('Project IDs must be unique.');
  }
  const projectIds = new Set(projects.map(project => project.id));

  const tasks = value.tasks.map(task => {
    const status = task?.status;
    if (!['To do', 'In progress', 'Done'].includes(status)) throw new Error('Task status is invalid.');
    const projectId = cleanText(task?.projectId, 'Task project ID', 100, true);
    const assigneeId = cleanText(task?.assigneeId, 'Task assignee ID', 100, true);
    if (!projectIds.has(projectId) || !memberIds.has(assigneeId)) throw new Error('Task references a missing project or member.');
    return {
      id: cleanText(task?.id, 'Task ID', 100, true),
      projectId,
      title: cleanText(task?.title, 'Task title', 120, true),
      assigneeId,
      dueDate: cleanText(task?.dueDate ?? '', 'Task due date', 10),
      status
    };
  });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) {
    throw new Error('Task IDs must be unique.');
  }
  return { members, projects, tasks };
}

function getWorkspace(userId) {
  const members = database.prepare(
    'SELECT id, name, email FROM members WHERE user_id = ? ORDER BY is_self DESC, name'
  ).all(userId);
  const projects = database.prepare(
    'SELECT id, name, course, description, deadline, owner FROM projects WHERE user_id = ? ORDER BY rowid'
  ).all(userId);
  const projectMembers = database.prepare(
    'SELECT project_id, member_id FROM project_members WHERE user_id = ?'
  ).all(userId);
  const tasks = database.prepare(
    'SELECT id, project_id AS projectId, title, assignee_id AS assigneeId, due_date AS dueDate, status FROM tasks WHERE user_id = ? ORDER BY rowid'
  ).all(userId);
  for (const project of projects) {
    project.members = projectMembers
      .filter(item => item.project_id === project.id)
      .map(item => item.member_id);
  }
  return { members, projects, tasks };
}

function saveWorkspace(userId, workspace) {
  runTransaction(() => {
    database.prepare('DELETE FROM projects WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM members WHERE user_id = ? AND id <> ?').run(userId, 'you');
    const insertMember = database.prepare(
      'INSERT INTO members (id, user_id, name, email, is_self) VALUES (?, ?, ?, ?, ?)'
    );
    const updateSelf = database.prepare(
      'UPDATE members SET name = ?, email = ?, is_self = 1 WHERE user_id = ? AND id = ?'
    );
    for (const member of workspace.members) {
      if (member.id === 'you') updateSelf.run(member.name, member.email, userId, 'you');
      else insertMember.run(member.id, userId, member.name, member.email, 0);
    }
    const insertProject = database.prepare(
      'INSERT INTO projects (id, user_id, name, course, description, deadline, owner) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertProjectMember = database.prepare(
      'INSERT INTO project_members (user_id, project_id, member_id) VALUES (?, ?, ?)'
    );
    for (const project of workspace.projects) {
      insertProject.run(project.id, userId, project.name, project.course, project.description, project.deadline, project.owner);
      for (const memberId of project.members) insertProjectMember.run(userId, project.id, memberId);
    }
    const insertTask = database.prepare(
      'INSERT INTO tasks (id, user_id, project_id, title, assignee_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const task of workspace.tasks) {
      insertTask.run(task.id, userId, task.projectId, task.title, task.assigneeId, task.dueDate, task.status);
    }
  });
}

function seedWorkspace(userId, name, email) {
  const initialWorkspace = {
    members: [{ id: 'you', name, email }],
    projects: [{
      id: 'sample-project',
      name: 'Campus sustainability study',
      course: 'Environmental Science',
      description: 'Explore practical ways to make our campus more sustainable.',
      deadline: '',
      owner: name,
      members: ['you']
    }],
    tasks: [{
      id: 'sample-task',
      projectId: 'sample-project',
      title: 'Collect initial research sources',
      assigneeId: 'you',
      dueDate: '',
      status: 'In progress'
    }]
  };
  database.prepare(
    'INSERT INTO members (id, user_id, name, email, is_self) VALUES (?, ?, ?, ?, 1)'
  ).run('you', userId, name, email);
  const project = initialWorkspace.projects[0];
  database.prepare(
    'INSERT INTO projects (id, user_id, name, course, description, deadline, owner) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(project.id, userId, project.name, project.course, project.description, project.deadline, project.owner);
  database.prepare(
    'INSERT INTO project_members (user_id, project_id, member_id) VALUES (?, ?, ?)'
  ).run(userId, project.id, 'you');
  const task = initialWorkspace.tasks[0];
  database.prepare(
    'INSERT INTO tasks (id, user_id, project_id, title, assignee_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(task.id, userId, task.projectId, task.title, task.assigneeId, task.dueDate, task.status);
}

function regenerateSession(request, userId) {
  return new Promise((resolvePromise, rejectPromise) => {
    request.session.regenerate(error => {
      if (error) return rejectPromise(error);
      request.session.userId = userId;
      return resolvePromise();
    });
  });
}

app.post('/api/auth/register', async (request, response, next) => {
  try {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (name.length < 2 || name.length > 50) {
      return response.status(400).json({ error: 'Name must be between 2 and 50 characters.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100) {
      return response.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return response.status(400).json({ error: 'Password must be between 8 and 72 characters.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = randomUUID();
    try {
      runTransaction(() => {
        database.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
          .run(userId, name, email, passwordHash);
        seedWorkspace(userId, name, email);
      });
    } catch (error) {
      if (error.errcode === 2067) {
        return response.status(409).json({ error: 'An account with that email already exists.' });
      }
      throw error;
    }
    await regenerateSession(request, userId);
    return response.status(201).json({ user: { id: userId, name, email } });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    const user = database.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?').get(email);
    if (!user || typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) {
      return response.status(401).json({ error: 'Email or password is incorrect.' });
    }
    await regenerateSession(request, user.id);
    return response.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', requireAuthentication, (request, response, next) => {
  request.session.destroy(error => {
    if (error) return next(error);
    response.clearCookie('teamflow.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return response.status(204).end();
  });
});

app.get('/api/auth/me', (request, response) => {
  if (!request.session.userId) return response.status(401).json({ error: 'Please sign in to continue.' });
  const user = database.prepare('SELECT id, name, email FROM users WHERE id = ?').get(request.session.userId);
  if (!user) return response.status(401).json({ error: 'Please sign in to continue.' });
  return response.json({ user });
});

app.get('/api/workspace', requireAuthentication, (request, response) => {
  return response.json(getWorkspace(request.session.userId));
});

app.put('/api/workspace', requireAuthentication, (request, response, next) => {
  let workspace;
  try {
    workspace = validateWorkspace(request.body);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
  try {
    saveWorkspace(request.session.userId, workspace);
    return response.json(getWorkspace(request.session.userId));
  } catch (error) {
    return next(error);
  }
});

app.get(['/', '/index.html'], (request, response) => response.redirect('/signin.html'));
app.get('/signin.html', (request, response) => response.sendFile(resolve(projectDirectory, 'frontend', 'signin.html')));

for (const page of ['dashboard.html', 'projects.html', 'tasks.html', 'team.html']) {
  app.get(`/${page}`, (request, response) => {
    if (!request.session.userId) return response.redirect('/signin.html');
    return response.sendFile(resolve(projectDirectory, 'frontend', page));
  });
}

app.use(express.static(resolve(projectDirectory, 'frontend'), { index: false }));
app.use('/api', (request, response) => response.status(404).json({ error: 'API route not found.' }));
app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  return response.status(500).json({ error: 'An unexpected server error occurred.' });
});

app.listen(port, () => {
  console.log(`Teamflow is running at http://localhost:${port}`);
});
