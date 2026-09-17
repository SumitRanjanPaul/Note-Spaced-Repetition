const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile } = require('obsidian');

// --- ALGORITHMS ---

function calcSM2(data, grade) {
  let interval = data.interval || 0;
  let rep = data.repetition || 0;
  let ease = data.easeFactor || 2.5;

  if (grade === 1) {
    rep = 0;
    interval = 1;
  } else if (rep === 0) {
    const firstIntervals = { 2: 2, 3: 5, 4: 12 };
    interval = firstIntervals[grade];
    rep = 1;
  } else if (rep === 1) {
    interval = Math.round(interval * 2.2);
    rep = 2;
  } else {
    interval = Math.round(interval * ease);
    rep++;
  }

  const gradeScore = { 1: 1, 2: 3, 3: 4, 4: 5 }[grade];
  ease = Math.max(1.3, ease + (0.1 - (5 - gradeScore) * (0.08 + (5 - gradeScore) * 0.02)));

  const due = new Date();
  due.setDate(due.getDate() + interval);

  return { interval, repetition: rep, easeFactor: ease, dueDate: due.toISOString(), lastGrade: grade };
}

function calcFSRS(data, grade, targetRetention = 0.9) {
  const initialStability = [1.0, 3.0, 7.0, 16.0];
  const w = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26];
  
  let s = data.stability || 0;
  let d = data.difficulty || 0;
  let interval = 1;

  if (!data.stability) {
    s = initialStability[grade - 1];
    d = Math.max(1, Math.min(10, w[4] - (grade - 3) * w[5]));
    interval = Math.round(s);
  } else {
    let lastReview = data.lastReview ? new Date(data.lastReview) : new Date();
    let elapsedDays = Math.max(1, Math.floor((new Date().getTime() - lastReview.getTime()) / (1000 * 3600 * 24)));
    
    const r = Math.pow(1 + elapsedDays / (9 * s), -1);

    if (grade === 1) {
      s = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
      interval = 1;
    } else {
      s = s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1));
      const factor = 19 / 81;
      interval = Math.max(Math.round(data.interval * 1.2), Math.round((s / factor) * (Math.pow(targetRetention, -1) - 1)));
    }
    d = Math.max(1, Math.min(10, d - w[6] * (grade - 3)));
  }

  const due = new Date();
  due.setDate(due.getDate() + interval);

  return {
    stability: s,
    difficulty: d,
    interval: interval,
    lastReview: new Date().toISOString(),
    dueDate: due.toISOString(),
    lastGrade: grade
  };
}

function getStudyDateString(cutoffHour = 4) {
  const now = new Date();
  const shifted = new Date(now.getTime() - cutoffHour * 3600 * 1000);
  return shifted.toISOString().split('T')[0];
}

const DEFAULT_SETTINGS = {
  algorithm: 'FSRS',
  reviewMode: 'balanced',
  desiredRetention: 0.9,
  maxDailyReviews: 50,
  cutoffHour: 4,
  buryShortcutKey: 'b',
  lastStudyDate: '',
  todayReviewedCount: 0,
  streakDays: 0,
  activeTagFilter: '',
  autoFoldHeadings: false,
  shuffleQueue: true,
  syncToProperties: true,
  excludeFolders: 'templates, archive',
  todayStats: { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 },
  reviewHistory: {}
};

module.exports = class NoteSRSPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.reviewBarEl = null;
    this.currentQueue = [];
    this.currentFile = null;
    this.keyListener = null;

    this.addCommand({
      id: 'start-note-review',
      name: 'Start Note Review Session',
      callback: () => this.startReview()
    });

    this.addCommand({
      id: 'inspect-active-note-stats',
      name: 'Inspect Review History of Active Note (Stats)',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          if (!checking) new NoteHistoryModal(this.app, this, file).open();
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: 'view-vault-schedule',
      name: 'View Full Vault Review Schedule (Dates)',
      callback: () => new VaultScheduleModal(this.app, this).open()
    });

    this.addCommand({
      id: 'choose-subject-review',
      name: 'Choose Subject / Tag to Review...',
      callback: () => new SubjectPickerModal(this.app, this).open()
    });

    this.addCommand({
      id: 'bury-current-note',
      name: 'Bury Active Note to Tomorrow',
      checkCallback: (checking) => {
        if (this.reviewBarEl && this.currentFile) {
          if (!checking) this.buryCurrentNote();
          return true;
        }
        return false;
      }
    });

    this.addRibbonIcon('book-open', 'Review Due Notes', () => {
      this.startReview();
    });

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.settings.reviewHistory[oldPath]) {
        this.settings.reviewHistory[file.path] = this.settings.reviewHistory[oldPath];
        delete this.settings.reviewHistory[oldPath];
        this.saveSettings();
      }
    }));

    this.addSettingTab(new SRSSettingTab(this.app, this));
  }

  onunload() {
    this.removeReviewBar();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.buryShortcutKey) this.settings.buryShortcutKey = 'b';
    await this.checkDailyReset();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async checkDailyReset() {
    const currentStudyDay = getStudyDateString(this.settings.cutoffHour);
    if (this.settings.lastStudyDate !== currentStudyDay) {
      if (this.settings.lastStudyDate) {
        const prevDate = new Date(this.settings.lastStudyDate);
        const currDate = new Date(currentStudyDay);
        const diffDays = Math.round((currDate - prevDate) / (1000 * 3600 * 24));
        if (diffDays === 1) {
          this.settings.streakDays = (this.settings.streakDays || 0) + 1;
        } else if (diffDays > 1) {
          this.settings.streakDays = 1;
        }
      } else {
        this.settings.streakDays = 1;
      }

      this.settings.lastStudyDate = currentStudyDay;
      this.settings.todayReviewedCount = 0;
      this.settings.todayStats = { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 };
      await this.saveSettings();
    }
  }

  getFileTags(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const tags = new Set();

    if (cache.tags) {
      cache.tags.forEach(t => tags.add(t.tag.replace(/^#/, '').toLowerCase().trim()));
    }

    if (cache.frontmatter) {
      for (const [key, val] of Object.entries(cache.frontmatter)) {
        const lowerKey = key.toLowerCase();
        if (['tags', 'tag', 'subject', 'topic'].includes(lowerKey)) {
          if (Array.isArray(val)) {
            val.forEach(item => {
              if (item) tags.add(String(item).replace(/^#/, '').toLowerCase().trim());
            });
          } else if (typeof val === 'string') {
            val.split(/[, ]+/).forEach(item => {
              if (item) tags.add(item.replace(/^#/, '').toLowerCase().trim());
            });
          }
        }
      }
    }
    return Array.from(tags);
  }

  async buildReviewQueue(remainingQuota, customTag = null) {
    const files = this.app.vault.getMarkdownFiles();
    const excludes = this.settings.excludeFolders.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    
    const filter = (customTag !== null ? customTag : this.settings.activeTagFilter) || '';
    const cleanFilter = filter.trim().replace(/^#/, '').toLowerCase();
    
    const now = new Date();
    const dueRevisions = [];
    const newNotes = [];

    for (const file of files) {
      if (excludes.some(folder => file.path.toLowerCase().startsWith(folder))) continue;

      if (cleanFilter) {
        const fileTags = this.getFileTags(file);
        const matches = fileTags.some(t => t === cleanFilter || t.includes(cleanFilter) || cleanFilter.includes(t));
        if (!matches) continue;
      }

      const meta = this.settings.reviewHistory[file.path];
      if (!meta || !meta.dueDate) {
        newNotes.push(file);
      } else if (new Date(meta.dueDate) <= now) {
        dueRevisions.push({ file, meta, dueDate: new Date(meta.dueDate) });
      }
    }

    dueRevisions.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

    let finalQueue = [];
    const mode = this.settings.reviewMode;

    if (mode === 'reviews_only') {
      finalQueue = dueRevisions.map(item => item.file);
    } else if (mode === 'new_only') {
      finalQueue = newNotes;
    } else if (mode === 'hard_first') {
      const hardDue = [];
      const normalDue = [];
      dueRevisions.forEach(item => {
        const isHard = (item.meta.lastGrade && item.meta.lastGrade <= 2) || (item.meta.difficulty && item.meta.difficulty >= 6);
        if (isHard) hardDue.push(item.file);
        else normalDue.push(item.file);
      });
      finalQueue = [...hardDue, ...normalDue, ...newNotes];
    } else {
      finalQueue = [...dueRevisions.map(item => item.file), ...newNotes];
    }

    if (this.settings.shuffleQueue && finalQueue.length > 1) {
      for (let i = finalQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [finalQueue[i], finalQueue[j]] = [finalQueue[j], finalQueue[i]];
      }
    }

    return finalQueue.slice(0, remainingQuota);
  }

  async startReview(customTag = null) {
    await this.checkDailyReset();

    if (customTag !== null) {
      this.settings.activeTagFilter = customTag;
      await this.saveSettings();
    }

    const remainingQuota = this.settings.maxDailyReviews - this.settings.todayReviewedCount;
    if (remainingQuota <= 0) {
      new Notice(`Daily limit reached (${this.settings.todayReviewedCount}/${this.settings.maxDailyReviews})!`);
      this.removeReviewBar();
      return;
    }

    this.currentQueue = await this.buildReviewQueue(remainingQuota, customTag);

    if (this.currentQueue.length === 0) {
      const subject = this.settings.activeTagFilter ? `#${this.settings.activeTagFilter}` : 'All';
      new Notice(`No due notes found for [${subject}].`);
      this.removeReviewBar();
      return;
    }

    this.openNextInQueue();
  }

  async openNextInQueue() {
    if (this.currentQueue.length === 0) {
      new Notice(`🎉 Session complete! Today: ${this.settings.todayReviewedCount}/${this.settings.maxDailyReviews}`);
      this.removeReviewBar();
      return;
    }

    const file = this.currentQueue.shift();
    this.currentFile = file;

    await this.app.workspace.getLeaf(false).openFile(file);

    if (this.settings.autoFoldHeadings) {
      setTimeout(() => {
        this.app.commands.executeCommandById('editor:fold-all');
      }, 150);
    }

    this.renderReviewBar(file);
  }

  showReviewBarForFile(file) {
    this.currentFile = file;
    this.renderReviewBar(file);
  }

  async buryCurrentNote() {
    if (!this.currentFile) return;
    const file = this.currentFile;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = this.settings.reviewHistory[file.path] || {};
    existing.dueDate = tomorrow.toISOString();
    
    // Track stats & log
    existing.totalAppearances = (existing.totalAppearances || 0) + 1;
    existing.ratingsCount = existing.ratingsCount || { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 };
    existing.ratingsCount.buried = (existing.ratingsCount.buried || 0) + 1;
    existing.historyLog = existing.historyLog || [];
    existing.historyLog.push({
      date: new Date().toLocaleString(),
      rating: 'Buried',
      interval: '1d (Deferred)'
    });

    this.settings.reviewHistory[file.path] = existing;
    this.settings.todayStats.buried = (this.settings.todayStats.buried || 0) + 1;
    await this.saveSettings();

    new Notice(`💤 Postponed to tomorrow: ${file.basename}`);

    if (this.currentQueue.length > 0) {
      this.openNextInQueue();
    } else {
      this.removeReviewBar();
    }
  }

  async rateAndAdvance(grade) {
    if (!this.currentFile) return;
    const file = this.currentFile;
    
    await this.handleRating(file, grade);
    
    this.settings.todayReviewedCount++;
    this.settings.todayStats[grade] = (this.settings.todayStats[grade] || 0) + 1;
    await this.saveSettings();

    if (this.currentQueue.length > 0 && this.settings.todayReviewedCount < this.settings.maxDailyReviews) {
      this.openNextInQueue();
    } else {
      new Notice(`🎉 Target reached: ${this.settings.todayReviewedCount}/${this.settings.maxDailyReviews} done!`);
      this.removeReviewBar();
    }
  }

  renderReviewBar(file) {
    this.removeReviewBar();

    const bar = document.createElement('div');
    bar.addClass('note-srs-bar');
    this.reviewBarEl = bar;

    const data = this.settings.reviewHistory[file.path] || {};
    
    const preview = (grade) => {
      let res = this.settings.algorithm === 'SM-2' 
        ? calcSM2(data, grade) 
        : calcFSRS(data, grade, this.settings.desiredRetention);
      return res.interval + 'd';
    };

    const info = bar.createEl('div', { cls: 'note-srs-info' });
    
    const done = this.settings.todayReviewedCount;
    const total = this.settings.maxDailyReviews;
    const left = Math.max(0, total - done);
    const streak = this.settings.streakDays ? `🔥 ${this.settings.streakDays}d | ` : '';

    const leftInfo = info.createEl('div');
    leftInfo.createEl('span', { text: `${streak}Today: ${done}/${total} (${left} left) | ` });

    const activeSubject = this.settings.activeTagFilter ? `#${this.settings.activeTagFilter}` : 'All Subjects';
    const tagBadge = leftInfo.createEl('span', { 
      cls: 'note-srs-tag-badge', 
      text: `🏷️ ${activeSubject} ▾`
    });
    tagBadge.onclick = () => new SubjectPickerModal(this.app, this).open();

    // Right Controls: Stats Icon + Close
    const rightContainer = info.createEl('div');
    
    const statsBtn = rightContainer.createEl('span', { 
      cls: 'note-srs-icon-btn', 
      text: '📊', 
      attr: { title: 'Inspect Review History (I)' } 
    });
    statsBtn.onclick = () => new NoteHistoryModal(this.app, this, file).open();

    const closeBtn = rightContainer.createEl('span', { cls: 'note-srs-icon-btn', text: '✕', attr: { title: 'Close' } });
    closeBtn.onclick = () => this.removeReviewBar();

    // 4 Symmetrical Buttons
    const actions = bar.createEl('div', { cls: 'note-srs-actions' });

    const buttons = [
      { keyLabel: '1', label: 'Again', grade: 1, cls: 'btn-again', sub: preview(1) },
      { keyLabel: '2', label: 'Hard',  grade: 2, cls: 'btn-hard',  sub: preview(2) },
      { keyLabel: '3', label: 'Good',  grade: 3, cls: 'btn-good',  sub: preview(3) },
      { keyLabel: '4', label: 'Easy',  grade: 4, cls: 'btn-easy',  sub: preview(4) }
    ];

    buttons.forEach(b => {
      const btn = actions.createEl('button', { cls: `note-srs-btn ${b.cls}` });
      btn.createEl('span', { text: `[${b.keyLabel}] ${b.label}` });
      btn.createEl('span', { cls: 'note-srs-sub', text: b.sub });
      btn.onclick = () => this.rateAndAdvance(b.grade);
    });

    document.body.appendChild(bar);

    // Keyboard Listener
    this.keyListener = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const configuredBuryKey = (this.settings.buryShortcutKey || 'b').toLowerCase();
      const key = e.key.toLowerCase();

      if (['1', '2', '3', '4'].includes(e.key) || ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4'].includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const grade = parseInt(e.key.replace('Numpad', ''));
        this.rateAndAdvance(grade);
      } else if (key === configuredBuryKey || e.code === 'KeyB') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.buryCurrentNote();
      } else if (key === 'i') {
        // 'I' to open stats
        e.preventDefault();
        new NoteHistoryModal(this.app, this, file).open();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.removeReviewBar();
      }
    };

    window.addEventListener('keydown', this.keyListener, true);
  }

  async handleRating(file, grade) {
    const existing = this.settings.reviewHistory[file.path] || {};
    let updated = this.settings.algorithm === 'SM-2'
      ? calcSM2(existing, grade)
      : calcFSRS(existing, grade, this.settings.desiredRetention);

    // Comprehensive Stats tracking
    updated.totalReviews = (existing.totalReviews || 0) + 1;
    updated.totalAppearances = (existing.totalAppearances || 0) + 1;
    updated.ratingsCount = existing.ratingsCount || { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 };
    updated.ratingsCount[grade] = (updated.ratingsCount[grade] || 0) + 1;
    
    const gradeLabels = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
    updated.historyLog = existing.historyLog || [];
    updated.historyLog.push({
      date: new Date().toLocaleString(),
      rating: gradeLabels[grade],
      interval: `${updated.interval}d`
    });

    this.settings.reviewHistory[file.path] = updated;
    await this.saveSettings();

    if (this.settings.syncToProperties) {
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm['srs-due'] = updated.dueDate.split('T')[0];
          fm['srs-interval'] = `${updated.interval}d`;
          fm['srs-status'] = updated.interval >= 21 ? 'Mastered' : (updated.interval >= 7 ? 'Reviewing' : 'Learning');
        });
      } catch (err) {
        // silent catch
      }
    }
  }

  removeReviewBar() {
    if (this.keyListener) {
      window.removeEventListener('keydown', this.keyListener, true);
      this.keyListener = null;
    }
    if (this.reviewBarEl) {
      this.reviewBarEl.remove();
      this.reviewBarEl = null;
    }
  }
};

// --- MODAL: ACTIVE NOTE HISTORY & STATS INSPECTOR ---

class NoteHistoryModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const data = this.plugin.settings.reviewHistory[this.file.path] || {};
    const stats = data.ratingsCount || { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 };
    const history = data.historyLog || [];

    contentEl.createEl('h2', { text: `📊 Review Stats: ${this.file.basename}` });

    // Formatting Due Date
    let dueStr = 'Not scheduled yet (New Note)';
    if (data.dueDate) {
      const d = new Date(data.dueDate);
      const daysDiff = Math.ceil((d.getTime() - new Date().getTime()) / (1000 * 3600 * 24));
      const relative = daysDiff <= 0 ? 'Due Today' : `in ${daysDiff} days`;
      dueStr = `${d.toLocaleDateString()} (${relative})`;
    }

    // Top KPI Cards
    const grid = contentEl.createEl('div', { cls: 'srs-stats-grid' });
    
    const kpis = [
      { label: 'Next Due Date', val: dueStr },
      { label: 'Current Interval', val: data.interval ? `${data.interval}d` : '0d' },
      { label: 'Total Times Revised', val: data.totalReviews || 0 },
      { label: 'Total Appearances', val: data.totalAppearances || 0 }
    ];

    kpis.forEach(k => {
      const box = grid.createEl('div', { cls: 'srs-metric-box' });
      box.createEl('div', { text: String(k.val), cls: 'srs-metric-val' });
      box.createEl('div', { text: k.label, attr: { style: 'font-size: 0.8em; opacity: 0.8;' } });
    });

    // Rating Breakdown Row
    contentEl.createEl('h3', { text: 'Rating Distribution', attr: { style: 'margin-top: 15px;' } });
    const distGrid = contentEl.createEl('div', { cls: 'srs-stats-grid' });
    
    const ratings = [
      { label: 'Again (1)', count: stats[1] || 0, color: '#eb5757' },
      { label: 'Hard (2)',  count: stats[2] || 0, color: '#f2994a' },
      { label: 'Good (3)',  count: stats[3] || 0, color: '#27ae60' },
      { label: 'Easy (4)',  count: stats[4] || 0, color: '#2f80ed' },
      { label: 'Buried',    count: stats.buried || 0, color: 'var(--text-muted)' }
    ];

    ratings.forEach(r => {
      const box = distGrid.createEl('div', { cls: 'srs-metric-box' });
      box.createEl('div', { text: String(r.count), cls: 'srs-metric-val', attr: { style: `color: ${r.color};` } });
      box.createEl('div', { text: r.label, attr: { style: 'font-size: 0.8em; opacity: 0.8;' } });
    });

    // History Log Table
    contentEl.createEl('h3', { text: 'Review History Log', attr: { style: 'margin-top: 20px;' } });
    
    if (history.length === 0) {
      contentEl.createEl('p', { text: 'No reviews recorded for this note yet.', attr: { style: 'color: var(--text-faint);' } });
    } else {
      const tableContainer = contentEl.createEl('div', { cls: 'srs-table-container' });
      const table = tableContainer.createEl('table', { cls: 'srs-data-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: 'Date & Time' });
      headerRow.createEl('th', { text: 'Rating Given' });
      headerRow.createEl('th', { text: 'New Interval' });

      const tbody = table.createEl('tbody');
      // Show newest first
      [...history].reverse().forEach(entry => {
        const row = tbody.createEl('tr');
        row.createEl('td', { text: entry.date });
        row.createEl('td', { text: entry.rating });
        row.createEl('td', { text: entry.interval });
      });
    }

    const closeBtn = contentEl.createEl('button', { text: 'Close', attr: { style: 'margin-top: 20px; width: 100%;' } });
    closeBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- MODAL: VAULT REVIEW SCHEDULE TABLE ---

class VaultScheduleModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '📅 Vault Spaced Repetition Schedule' });

    const files = this.app.vault.getMarkdownFiles();
    const scheduled = [];

    files.forEach(f => {
      const meta = this.plugin.settings.reviewHistory[f.path];
      if (meta && meta.dueDate) {
        scheduled.push({
          file: f,
          dueDate: new Date(meta.dueDate),
          interval: meta.interval || 0,
          reps: meta.totalReviews || meta.repetition || 0,
          tags: this.plugin.getFileTags(f).join(', ')
        });
      }
    });

    scheduled.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

    contentEl.createEl('p', { 
      text: `Total notes scheduled: ${scheduled.length}. Sorted chronologically by upcoming review date:` 
    });

    if (scheduled.length === 0) {
      contentEl.createEl('p', { text: 'No notes scheduled yet. Start reviewing to build your schedule!', attr: { style: 'color: var(--text-faint);' } });
      return;
    }

    const tableContainer = contentEl.createEl('div', { cls: 'srs-table-container' });
    const table = tableContainer.createEl('table', { cls: 'srs-data-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Note Title' });
    headerRow.createEl('th', { text: 'Tags / Subject' });
    headerRow.createEl('th', { text: 'Scheduled Due Date' });
    headerRow.createEl('th', { text: 'Interval' });
    headerRow.createEl('th', { text: 'Revisions' });

    const tbody = table.createEl('tbody');
    scheduled.forEach(item => {
      const row = tbody.createEl('tr');
      
      const titleCell = row.createEl('td');
      const link = titleCell.createEl('a', { text: item.file.basename, cls: 'internal-link' });
      link.onclick = async () => {
        this.close();
        await this.app.workspace.getLeaf(false).openFile(item.file);
      };

      row.createEl('td', { text: item.tags || '-' });
      
      const daysDiff = Math.ceil((item.dueDate.getTime() - new Date().getTime()) / (1000 * 3600 * 24));
      const rel = daysDiff <= 0 ? 'Due Today' : `in ${daysDiff}d`;
      row.createEl('td', { text: `${item.dueDate.toLocaleDateString()} (${rel})` });

      row.createEl('td', { text: `${item.interval}d` });
      row.createEl('td', { text: String(item.reps) });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- SUBJECT PICKER MODAL ---

class SubjectPickerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Choose Subject to Review' });

    const files = this.app.vault.getMarkdownFiles();
    const tagCounts = {};
    let totalAll = 0;

    files.forEach(f => {
      const tags = this.plugin.getFileTags(f);
      const meta = this.plugin.settings.reviewHistory[f.path];
      const isDue = !meta || !meta.dueDate || new Date(meta.dueDate) <= new Date();

      if (isDue) {
        totalAll++;
        tags.forEach(t => {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
      }
    });

    const list = contentEl.createEl('div', { 
      attr: { style: 'display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; margin-top: 10px;' } 
    });

    const allBtn = list.createEl('button', { text: `🌐 All Subjects (${totalAll} due)` });
    allBtn.style.padding = '10px';
    allBtn.style.fontWeight = 'bold';
    allBtn.onclick = () => {
      this.close();
      this.plugin.startReview('');
    };

    const sortedTags = Object.keys(tagCounts).sort();
    if (sortedTags.length === 0) {
      list.createEl('div', { text: 'No tags found in notes yet.', attr: { style: 'color: var(--text-faint); margin: 10px 0;' } });
    } else {
      sortedTags.forEach(tag => {
        const btn = list.createEl('button', { text: `🏷️ #${tag} (${tagCounts[tag]} due)` });
        btn.style.padding = '10px';
        btn.onclick = () => {
          this.close();
          this.plugin.startReview(tag);
        };
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- DANGER: RESET CONFIRMATION MODAL ---

class ResetConfirmModal extends Modal {
  constructor(app, plugin, onConfirm) {
    super(app);
    this.plugin = plugin;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '⚠️ Reset All FSRS Review Data?' });

    contentEl.createEl('p', {
      text: 'This will permanently wipe all review history, stability, difficulty scores, intervals, and due dates across EVERY note in your vault.',
      attr: { style: 'color: var(--text-warning); font-weight: 500;' }
    });

    contentEl.createEl('p', {
      text: 'Every note will return to a completely brand-new state. Your markdown content will remain safe and untouched, but all learning schedules will start from Day 0.'
    });

    contentEl.createEl('p', {
      text: 'Are you absolutely sure? This action cannot be undone.',
      attr: { style: 'font-weight: bold;' }
    });

    const btnRow = contentEl.createEl('div', { 
      attr: { style: 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;' } 
    });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.onclick = () => this.close();

    const dangerBtn = btnRow.createEl('button', { 
      text: 'Yes, Wipe Everything', 
      attr: { style: 'background-color: #eb5757; color: white; border: none;' } 
    });
    dangerBtn.onclick = async () => {
      this.close();
      await this.onConfirm();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- SETTINGS TAB ---

class SRSSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Note Spaced Repetition Settings' });

    // Schedule explorer shortcut in settings
    new Setting(containerEl)
      .setName('View Full Vault Schedule')
      .setDesc('View a searchable table of all scheduled notes and their exact upcoming due dates.')
      .addButton(btn => btn
        .setButtonText('📅 Open Schedule Table')
        .onClick(() => new VaultScheduleModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName('Bury Shortcut Key')
      .setDesc('Single key to postpone a note until tomorrow without any on-screen button (Default: b).')
      .addText(text => text
        .setPlaceholder('b')
        .setValue(this.plugin.settings.buryShortcutKey || 'b')
        .onChange(async (value) => {
          const trimmed = value.trim().toLowerCase();
          if (trimmed.length > 0) {
            this.plugin.settings.buryShortcutKey = trimmed[0];
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Review Priority Mode')
      .setDesc('Decide what notes fill your daily quota.')
      .addDropdown(drop => drop
        .addOption('balanced', 'Balanced (Due Revisions first, then New Notes)')
        .addOption('reviews_only', 'Revisions Only (Zero new notes, only due reviews)')
        .addOption('hard_first', 'Hard Notes First (Difficult & struggling notes first)')
        .addOption('new_only', 'New Notes Only (Only unreviewed notes)')
        .setValue(this.plugin.settings.reviewMode)
        .onChange(async (val) => {
          this.plugin.settings.reviewMode = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Daily Review Target')
      .setDesc('Maximum number of notes to review per day.')
      .addText(text => text
        .setPlaceholder('50')
        .setValue(String(this.plugin.settings.maxDailyReviews))
        .onChange(async (val) => {
          const num = parseInt(val);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.maxDailyReviews = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Active Subject Filter')
      .setDesc('Only review notes matching this tag (e.g. clippings, polity). Leave blank for all.')
      .addText(text => text
        .setPlaceholder('e.g. clippings')
        .setValue(this.plugin.settings.activeTagFilter)
        .onChange(async (value) => {
          this.plugin.settings.activeTagFilter = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Shuffle Review Queue')
      .setDesc('Randomizes order of due notes to prevent reading identical topics in a row.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.shuffleQueue)
        .onChange(async (val) => {
          this.plugin.settings.shuffleQueue = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auto-Fold Headings')
      .setDesc('Automatically collapses all ## headings when a note opens.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoFoldHeadings)
        .onChange(async (val) => {
          this.plugin.settings.autoFoldHeadings = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync Status to Note Properties')
      .setDesc('Writes srs-due and srs-interval into note frontmatter.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncToProperties)
        .onChange(async (val) => {
          this.plugin.settings.syncToProperties = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('New Day Starts At (Hour)')
      .setDesc('Hour (0–23) when your study day resets. Default is 4 (4:00 AM).')
      .addDropdown(drop => {
        for (let i = 0; i < 24; i++) {
          const label = `${i.toString().padStart(2, '0')}:00 ${i < 12 ? 'AM' : 'PM'}`;
          drop.addOption(String(i), label);
        }
        drop.setValue(String(this.plugin.settings.cutoffHour));
        drop.onChange(async (val) => {
          this.plugin.settings.cutoffHour = parseInt(val);
          await this.plugin.checkDailyReset();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Algorithm')
      .setDesc('Choose between modern FSRS or classic SM-2.')
      .addDropdown(drop => drop
        .addOption('FSRS', 'FSRS (Recommended)')
        .addOption('SM-2', 'SM-2 (Classic)')
        .setValue(this.plugin.settings.algorithm)
        .onChange(async (value) => {
          this.plugin.settings.algorithm = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Exclude Folders')
      .setDesc('Comma-separated folders to skip (e.g., templates, archive).')
      .addText(text => text
        .setPlaceholder('templates, archive')
        .setValue(this.plugin.settings.excludeFolders)
        .onChange(async (value) => {
          this.plugin.settings.excludeFolders = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Reset Today’s Progress')
      .setDesc(`Currently reviewed: ${this.plugin.settings.todayReviewedCount} notes today.`)
      .addButton(btn => btn
        .setButtonText('Reset to 0')
        .onClick(async () => {
          this.plugin.settings.todayReviewedCount = 0;
          this.plugin.settings.todayStats = { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 };
          await this.plugin.saveSettings();
          new Notice("Today's count reset to 0.");
          this.display();
        }));

    // --- DANGER ZONE ---
    containerEl.createEl('h2', { 
      text: 'Danger Zone', 
      attr: { style: 'color: #eb5757; margin-top: 30px; border-top: 1px solid var(--background-modifier-border); padding-top: 15px;' } 
    });

    new Setting(containerEl)
      .setName('Reset All FSRS / SRS Review History')
      .setDesc('Permanently wipes all memory stability, ease factors, intervals, and schedules across your entire vault. All notes return to Day 0.')
      .addButton(btn => btn
        .setButtonText('Reset All Data')
        .setWarning()
        .onClick(() => {
          new ResetConfirmModal(this.app, this.plugin, async () => {
            this.plugin.settings.reviewHistory = {};
            this.plugin.settings.todayReviewedCount = 0;
            this.plugin.settings.todayStats = { 1: 0, 2: 0, 3: 0, 4: 0, buried: 0 };
            await this.plugin.saveSettings();
            new Notice('⚠️ Complete Reset Successful! All notes returned to Day 0.');
            this.display();
          }).open();
        }));
  }
}