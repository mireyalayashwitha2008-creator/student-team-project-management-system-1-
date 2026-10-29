function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function apiRequest(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

let workspace;
const page = document.body.dataset.page;
const statuses = ['To do', 'In progress', 'Done'];
let saveQueue = Promise.resolve();

function showNotice(message) {
  let notice = document.getElementById('app-notice');
  if (!notice) {
    notice = document.createElement('p');
    notice.id = 'app-notice';
    notice.className = 'app-notice';
    notice.setAttribute('role', 'alert');
    document.body.prepend(notice);
  }
  notice.textContent = message;
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function memberName(id) {
  return workspace.members.find(member => member.id === id)?.name || 'Unassigned';
}

function projectName(id) {
  return workspace.projects.find(project => project.id === id)?.name || 'Project removed';
}

function formatDate(date) {
  if (!date) return 'No deadline';
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? 'No deadline' : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function progressFor(projectId) {
  const tasks = workspace.tasks.filter(task => task.projectId === projectId);
  return tasks.length ? Math.round(tasks.filter(task => task.status === 'Done').length / tasks.length * 100) : 0;
}

function projectCard(project, editable = false) {
  const progress = progressFor(project.id);
  const memberNames = (project.members || []).map(memberName).join(', ') || 'No teammates yet';
  return `<article class="project-card">
    <div class="project-card-top"><span class="project-icon">✳</span>${editable ? `<button class="icon-button" data-action="edit-project" data-id="${escapeHTML(project.id)}" aria-label="Edit ${escapeHTML(project.name)}">···</button>` : ''}</div>
    <p class="eyebrow">${escapeHTML(project.course || 'ACADEMIC PROJECT')}</p><h3>${escapeHTML(project.name)}</h3>
    <p class="card-description">${escapeHTML(project.description || 'Add a description to tell your team what this project is about.')}</p>
    <div class="project-meta"><span>◷ ${escapeHTML(formatDate(project.deadline))}</span><span>♧ ${escapeHTML(memberNames)}</span></div>
    <div class="progress-label"><span>Progress</span><strong>${progress}%</strong></div><div class="progress-track"><span style="width:${progress}%"></span></div>
    ${editable ? `<div class="card-actions"><button class="text-button" data-action="edit-project" data-id="${escapeHTML(project.id)}">Edit details</button><button class="text-button danger" data-action="delete-project" data-id="${escapeHTML(project.id)}">Delete</button></div>` : ''}
  </article>`;
}

function taskRow(task, compact = false) {
  return `<article class="task-row ${compact ? 'compact' : ''}"><span class="task-check ${task.status === 'Done' ? 'checked' : ''}">${task.status === 'Done' ? '✓' : ''}</span><div class="task-details"><h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(projectName(task.projectId))} <span>·</span> ${escapeHTML(memberName(task.assigneeId))}</p></div><span class="task-date">${escapeHTML(formatDate(task.dueDate))}</span>${compact ? '' : `<select class="status-select status-${task.status.toLowerCase().replace(' ', '-')}" data-task-status="${escapeHTML(task.id)}" aria-label="Status for ${escapeHTML(task.title)}">${statuses.map(status => `<option ${task.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select><button class="icon-button remove-button" data-action="delete-task" data-id="${escapeHTML(task.id)}" aria-label="Delete task">×</button>`}</article>`;
}

function renderDashboard() {
  const completed = workspace.tasks.filter(task => task.status === 'Done').length;
  document.getElementById('dashboard-stats').innerHTML = `
    <article class="stat-card"><span class="stat-icon lilac">▧</span><div><p>Active projects</p><strong>${workspace.projects.length}</strong></div><span class="stat-note">in your workspace</span></article>
    <article class="stat-card"><span class="stat-icon peach">☷</span><div><p>Open tasks</p><strong>${workspace.tasks.length - completed}</strong></div><span class="stat-note">ready for progress</span></article>
    <article class="stat-card"><span class="stat-icon mint">✓</span><div><p>Tasks completed</p><strong>${completed}</strong></div><span class="stat-note">nice work, team</span></article>`;
  const projects = document.getElementById('dashboard-projects');
  projects.innerHTML = workspace.projects.length ? `<div class="dashboard-project-grid">${workspace.projects.slice(0, 4).map(project => projectCard(project)).join('')}</div>` : emptyState('No projects yet', 'Create a project to start organizing your team.');
  const upcoming = [...workspace.tasks].filter(task => task.status !== 'Done').sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 5);
  document.getElementById('dashboard-tasks').innerHTML = upcoming.length ? `<div class="upcoming-list">${upcoming.map(task => taskRow(task, true)).join('')}</div>` : emptyState('All caught up!', 'Add a task to keep your project moving.');
}

function emptyState(title, detail) {
  return `<div class="empty-state"><span>✦</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(detail)}</p></div>`;
}

function renderProjects() {
  document.getElementById('project-count').textContent = `${workspace.projects.length} ${workspace.projects.length === 1 ? 'project' : 'projects'}`;
  document.getElementById('projects-list').innerHTML = workspace.projects.length ? workspace.projects.map(project => projectCard(project, true)).join('') : emptyState('No projects yet', 'Use the form above to create your first project.');
}

function renderTasks() {
  const projectSelect = document.querySelector('#task-form [name="projectId"]');
  const taskForm = document.getElementById('task-form');
  projectSelect.innerHTML = workspace.projects.length ? workspace.projects.map(project => `<option value="${escapeHTML(project.id)}">${escapeHTML(project.name)}</option>`).join('') : '<option value="">Create a project first</option>';
  projectSelect.disabled = !workspace.projects.length;
  taskForm.querySelector('button[type="submit"]').disabled = !workspace.projects.length;
  taskForm.querySelector('[name="assigneeId"]').innerHTML = workspace.members.map(member => `<option value="${escapeHTML(member.id)}">${escapeHTML(member.name)}</option>`).join('');
  document.getElementById('task-count').textContent = `${workspace.tasks.length} ${workspace.tasks.length === 1 ? 'task' : 'tasks'}`;
  const tasks = [...workspace.tasks].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  document.getElementById('tasks-list').innerHTML = tasks.length ? tasks.map(task => taskRow(task)).join('') : emptyState('No tasks yet', 'Add a task above and assign it to a teammate.');
}

function renderTeam() {
  document.getElementById('member-count').textContent = `${workspace.members.length} ${workspace.members.length === 1 ? 'member' : 'members'}`;
  document.getElementById('members-list').innerHTML = workspace.members.map((member, index) => `<article class="member-card"><span class="avatar member-avatar">${escapeHTML(member.name.trim().charAt(0).toUpperCase() || '?')}</span><div class="member-details"><h3>${escapeHTML(member.name)}</h3><p>${escapeHTML(member.email || 'Team member')}</p></div>${member.id === 'you' ? '<span class="owner-tag">OWNER</span>' : `<button class="text-button danger" data-action="remove-member" data-id="${escapeHTML(member.id)}">Remove</button>`}</article>`).join('');
  document.getElementById('membership-list').innerHTML = workspace.projects.length ? workspace.projects.map(project => `<article class="membership-card"><div class="membership-heading"><div><h3>${escapeHTML(project.name)}</h3><p>${escapeHTML((project.members || []).map(memberName).join(', ') || 'No members assigned')}</p></div></div><div class="membership-controls"><select aria-label="Choose a teammate" id="member-select-${escapeHTML(project.id)}">${workspace.members.map(member => `<option value="${escapeHTML(member.id)}">${escapeHTML(member.name)}</option>`).join('')}</select><button class="button secondary small-button" data-action="add-project-member" data-id="${escapeHTML(project.id)}">Add to project</button>${(project.members || []).filter(id => id !== 'you').map(id => `<button class="member-chip" data-action="remove-project-member" data-project="${escapeHTML(project.id)}" data-id="${escapeHTML(id)}">${escapeHTML(memberName(id))} ×</button>`).join('')}</div></article>`).join('') : emptyState('Create a project first', 'Project membership will appear here.');
}

function render() {
  if (page === 'dashboard') renderDashboard();
  if (page === 'projects') renderProjects();
  if (page === 'tasks') renderTasks();
  if (page === 'team') renderTeam();
}

function update(mutator) {
  const operation = saveQueue.then(async () => {
    const updatedWorkspace = structuredClone(workspace);
    mutator(updatedWorkspace);
    workspace = await apiRequest('/api/workspace', {
      method: 'PUT',
      body: JSON.stringify(updatedWorkspace)
    });
    render();
  });
  saveQueue = operation.catch(error => showNotice(error.message));
  return saveQueue;
}

function initializeSignIn() {
  const form = document.getElementById('signin-form');
  const modeToggle = document.getElementById('auth-mode-toggle');
  const nameField = document.getElementById('name-field');
  const submitButton = form.querySelector('button[type="submit"]');
  const feedback = document.getElementById('signin-feedback');
  let mode = 'login';

  modeToggle.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    const registering = mode === 'register';
    nameField.hidden = !registering;
    nameField.querySelector('input').required = registering;
    submitButton.textContent = registering ? 'Create account' : 'Sign in';
    modeToggle.textContent = registering ? 'Already have an account? Sign in' : 'Need an account? Create one';
    feedback.textContent = '';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const registering = mode === 'register';
    submitButton.disabled = true;
    feedback.textContent = registering ? 'Creating your account…' : 'Signing in…';
    try {
      await apiRequest(registering ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          name: values.get('name'),
          email: values.get('email'),
          password: values.get('password')
        })
      });
      window.location.replace('/dashboard.html');
    } catch (error) {
      feedback.textContent = error.message;
      submitButton.disabled = false;
    }
  });
}

function initializeWorkspace() {
  if (page === 'projects') {
    document.getElementById('project-form').addEventListener('submit', event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const project = { id: makeId(), name: values.get('name').trim(), course: values.get('course').trim(), deadline: values.get('deadline'), description: values.get('description').trim(), owner: 'You', members: ['you'] };
      update(data => data.projects.unshift(project));
      event.currentTarget.reset();
    });

    document.getElementById('edit-project-form').addEventListener('submit', event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      update(data => {
        const project = data.projects.find(item => item.id === values.get('id'));
        if (project) Object.assign(project, { name: values.get('name').trim(), course: values.get('course').trim(), deadline: values.get('deadline'), description: values.get('description').trim() });
      });
      document.getElementById('project-dialog').close();
    });
  }

  if (page === 'tasks') {
    document.getElementById('task-form').addEventListener('submit', event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      update(data => data.tasks.unshift({ id: makeId(), title: values.get('title').trim(), projectId: values.get('projectId'), assigneeId: values.get('assigneeId'), dueDate: values.get('dueDate'), status: 'To do' }));
      event.currentTarget.reset();
    });
  }

  if (page === 'team') {
    document.getElementById('member-form').addEventListener('submit', event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      update(data => data.members.push({ id: makeId(), name: values.get('name').trim(), email: values.get('email').trim() }));
      event.currentTarget.reset();
    });
  }

  document.getElementById('signout-button')?.addEventListener('click', async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
      window.location.replace('/signin.html');
    } catch (error) {
      showNotice(error.message);
    }
  });

  document.body.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    switch (button.dataset.action) {
      case 'edit-project': {
        const project = workspace.projects.find(item => item.id === id);
        if (!project) return;
        const form = document.getElementById('edit-project-form');
        for (const field of ['id', 'name', 'course', 'deadline', 'description']) form.elements[field].value = project[field] || '';
        document.getElementById('project-dialog').showModal();
        break;
      }
      case 'close-dialog': document.getElementById('project-dialog').close(); break;
      case 'delete-project':
        if (confirm('Delete this project and its tasks?')) update(data => { data.projects = data.projects.filter(project => project.id !== id); data.tasks = data.tasks.filter(task => task.projectId !== id); });
        break;
      case 'delete-task': update(data => { data.tasks = data.tasks.filter(task => task.id !== id); }); break;
      case 'remove-member':
        if (confirm('Remove this teammate? Their assigned tasks will become assigned to You.')) update(data => {
          data.members = data.members.filter(member => member.id !== id);
          data.projects.forEach(project => { project.members = (project.members || []).filter(memberId => memberId !== id); });
          data.tasks.forEach(task => { if (task.assigneeId === id) task.assigneeId = 'you'; });
        });
        break;
      case 'add-project-member': {
        const memberId = document.getElementById(`member-select-${id}`)?.value;
        const project = workspace.projects.find(item => item.id === id);
        if (project && memberId && !(project.members || []).includes(memberId)) {
          update(data => { data.projects.find(item => item.id === id).members.push(memberId); });
        }
        break;
      }
      case 'remove-project-member':
        update(data => { const project = data.projects.find(item => item.id === button.dataset.project); if (project) project.members = (project.members || []).filter(memberId => memberId !== id); });
        break;
    }
  });

  document.body.addEventListener('change', event => {
    const taskId = event.target.dataset.taskStatus;
    if (!taskId) return;
    const status = event.target.value;
    update(data => { const task = data.tasks.find(item => item.id === taskId); if (task) task.status = status; });
  });
}

async function initialize() {
  if (page === 'signin') {
    initializeSignIn();
    return;
  }
  try {
    await apiRequest('/api/auth/me');
    workspace = await apiRequest('/api/workspace');
    initializeWorkspace();
    render();
  } catch (error) {
    if (error.status === 401) {
      window.location.replace('/signin.html');
      return;
    }
    showNotice('Could not connect to Teamflow. Make sure the backend is running, then refresh this page.');
  }
}

initialize();
