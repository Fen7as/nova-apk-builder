// =============================================================
// Main application logic — Nova APK Builder
// =============================================================

let selectedFile = null;
let buildReleaseId = null;
let pollTimer = null;
let buildStartTime = 0;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

// ---- Auth helpers ----
function getToken() {
  return sessionStorage.getItem('gh_token');
}

function isLoggedIn() {
  return !!getToken();
}

async function connectWithToken() {
  const statusEl = document.getElementById('auth-status');
  const btn = document.getElementById('btn-connect');

  btn.disabled = true;
  btn.textContent = 'Connecting...';
  statusEl.innerHTML = '<span>Opening GitHub authorization...</span>';

  try {
    // Start GitHub Device Flow
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body:
        'client_id=' + encodeURIComponent(CONFIG.GITHUB_CLIENT_ID) +
        '&scope=' + encodeURIComponent('repo')
    });

    const data = await response.json();

    if (!response.ok || !data.device_code) {
      throw new Error(
        data.error_description || 'Could not start GitHub authorization.'
      );
    }

    const verificationUri = data.verification_uri;
    const userCode = data.user_code;

    statusEl.innerHTML =
      '<span class="status-ok">' +
      '1) Open GitHub: <a href="' + escAttr(verificationUri) +
      '" target="_blank" rel="noopener">' + escHtml(verificationUri) + '</a><br>' +
      '2) Enter this code: <strong>' + escHtml(userCode) + '</strong><br>' +
      'Waiting for approval...' +
      '</span>';

    let interval = Math.max(data.interval || 5, 5) * 1000;
    const deadline = Date.now() + (data.expires_in * 1000);

    while (Date.now() < deadline) {
      await sleep(interval);

      const tokenResponse = await fetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          },
          body:
            'client_id=' + encodeURIComponent(CONFIG.GITHUB_CLIENT_ID) +
            '&device_code=' + encodeURIComponent(data.device_code) +
            '&grant_type=' +
            encodeURIComponent(
              'urn:ietf:params:oauth:grant-type:device_code'
            )
        }
      );

      const tokenData = await tokenResponse.json();

      if (tokenData.access_token) {
        sessionStorage.setItem('gh_token', tokenData.access_token);

        statusEl.innerHTML =
          '<span class="status-ok">Connected to GitHub successfully.</span>';

        btn.textContent = 'Connected';

        setTimeout(function() {
          showBuildUI();
        }, 400);

        return;
      }

      if (tokenData.error === 'authorization_pending') {
        continue;
      }

      if (tokenData.error === 'slow_down') {
        interval += 5000;
        continue;
      }

      throw new Error(
        tokenData.error_description ||
        'GitHub authorization failed.'
      );
    }

    throw new Error(
      'GitHub authorization expired. Please try again.'
    );

  } catch (err) {
    statusEl.innerHTML =
      '<span class="status-error">' +
      escHtml(err.message) +
      '</span>';

    btn.disabled = false;
    btn.textContent = 'Connect GitHub';
  }
}

function disconnect() {
  sessionStorage.removeItem('gh_token');

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  location.reload();
}

// ---- Init ----
(function init() {
  if (isLoggedIn()) {
    showBuildUI();
  }

  // Allow Enter key to connect if token input exists
  var tokenInput = document.getElementById('token-input');

  if (tokenInput) {
    tokenInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') connectWithToken();
    });
  }

  // Drag-and-drop
  var dz = document.getElementById('drop-zone');

  dz.addEventListener('click', function() {
    document.getElementById('file-input').click();
  });

  dz.addEventListener('dragover', function(e) {
    e.preventDefault();
    dz.classList.add('dragover');
  });

  dz.addEventListener('dragleave', function() {
    dz.classList.remove('dragover');
  });

  dz.addEventListener('drop', function(e) {
    e.preventDefault();
    dz.classList.remove('dragover');

    if (e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
})();

// ---- Show build UI after auth ----
function showBuildUI() {
  document.getElementById('step-auth').classList.add('hidden');
  document.getElementById('step-upload').classList.remove('hidden');
  document.getElementById('step-signing').classList.remove('hidden');
  document.getElementById('step-build').classList.remove('hidden');
}

// ---- File handling ----
function handleFileSelect(event) {
  if (event.target.files.length) {
    handleFile(event.target.files[0]);
  }
}

function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    alert('Please select a .zip file.');
    return;
  }

  var maxBytes = CONFIG.MAX_ZIP_MB * 1024 * 1024;

  if (file.size > maxBytes) {
    alert(
      'File is too large. Maximum size is ' +
      CONFIG.MAX_ZIP_MB +
      ' MB.'
    );
    return;
  }

  selectedFile = file;

  document.getElementById('file-name').textContent = file.name;
  document.getElementById('file-size').textContent = formatBytes(file.size);
  document.getElementById('file-info').classList.remove('hidden');
  document.getElementById('drop-zone').classList.add('hidden');
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ---- Start build ----
async function startBuild() {
  if (!selectedFile) {
    alert('Please select a ZIP file first.');
    return;
  }

  if (!getToken()) {
    alert('Your session expired. Please refresh the page and connect to GitHub again.');
    return;
  }

  var signingMode =
    document.querySelector('input[name="signing"]:checked').value;

  var btnBuild = document.getElementById('btn-build');

  btnBuild.disabled = true;
  btnBuild.textContent = 'Working...';

  // Reset progress
  document.getElementById('progress-steps').innerHTML = '';
  document.getElementById('progress-log').textContent = '';
  consecutiveErrors = 0;

  showSection('step-progress');

  setProgressTitle('Starting build...');

  addStep('pending', 'Uploading ZIP to GitHub...');
  addStep('pending', 'Triggering build workflow...');
  addStep('pending', 'Building APK...');
  addStep('pending', 'Signing APK...');
  addStep('pending', 'Preparing download...');

  updateStep(0, 'active', 'Uploading ZIP to GitHub...');

  try {
    // Upload
    var uploadResult =
      await GitHubAPI.uploadZip(selectedFile);

    buildReleaseId = uploadResult.releaseId;

    updateStep(
      0,
      'done',
      'ZIP uploaded (' + formatBytes(selectedFile.size) + ')'
    );

    // Trigger
    updateStep(
      1,
      'active',
      'Triggering build workflow...'
    );

    await GitHubAPI.triggerBuild(
      uploadResult.releaseId,
      uploadResult.blobSha,
      signingMode
    );

    updateStep(
      1,
      'done',
      'Build triggered successfully'
    );

    // Start polling
    updateStep(
      2,
      'active',
      'Waiting for build to start...'
    );

    buildStartTime = Date.now();

    await sleep(3000);

    pollBuildStatus();

  } catch (err) {
    var failedAt = -1;
    var steps =
      document.querySelectorAll('.progress-step');

    for (var i = steps.length - 1; i >= 0; i--) {
      if (steps[i].classList.contains('active')) {
        failedAt = i;
        break;
      }
    }

    if (failedAt >= 0) {
      updateStep(
        failedAt,
        'error',
        steps[failedAt]
          .querySelector('.step-text')
          .textContent + ' — failed'
      );
    }

    showResult(
      'error',
      'Build could not be started',
      err.message
    );
  }
}

// ---- Poll build ----
async function pollBuildStatus() {
  var elapsed =
    Date.now() - buildStartTime;

  if (elapsed > CONFIG.BUILD_TIMEOUT_MS) {
    showResult(
      'error',
      'Build timed out',
      'The build took longer than ' +
      Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000) +
      ' minutes. Check GitHub Actions for details.'
    );
    return;
  }

  try {
    var run =
      await GitHubAPI.getLatestRun();

    consecutiveErrors = 0;

    if (!run) {
      updateStep(
        1,
        'active',
        'Waiting for build to start...'
      );

      pollTimer = setTimeout(
        pollBuildStatus,
        CONFIG.POLL_INTERVAL_MS
      );

      return;
    }

    var status = run.status;
    var conclusion = run.conclusion;

    // Update progress based on status
    if (status === 'queued') {
      setProgressTitle(
        'Queued — waiting for a runner...'
      );

      updateStep(
        1,
        'active',
        'Waiting for GitHub Actions runner...'
      );

    } else if (status === 'in_progress') {
      setProgressTitle('Building APK...');

      updateStep(
        1,
        'done',
        'Build environment ready'
      );

      updateStep(
        2,
        'active',
        'Compiling your project...'
      );

      updateStep(
        3,
        'active',
        'Signing APK...'
      );
    }

    if (status === 'completed') {
      if (conclusion === 'success') {

        updateStep(
          1,
          'done',
          'Build environment ready'
        );

        updateStep(
          2,
          'done',
          'Project compiled successfully'
        );

        updateStep(
          3,
          'done',
          'APK signed'
        );

        updateStep(
          4,
          'active',
          'Preparing download links...'
        );

        await onBuildSuccess(run);

      } else {
        await onBuildFailure(run);
      }

      return;
    }

    pollTimer = setTimeout(
      pollBuildStatus,
      CONFIG.POLL_INTERVAL_MS
    );

  } catch (err) {
    consecutiveErrors++;

    console.warn(
      'Poll error (' +
      consecutiveErrors +
      '):',
      err.message
    );

    if (
      consecutiveErrors >=
      MAX_CONSECUTIVE_ERRORS
    ) {
      showResult(
        'error',
        'Lost connection to GitHub',
        'Failed to check build status ' +
        MAX_CONSECUTIVE_ERRORS +
        ' times in a row. ' +
        'Check your internet connection, then refresh the page. ' +
        'Your build may still be running on GitHub.'
      );

      return;
    }

    // Show a subtle warning but keep polling
    var logEl =
      document.getElementById('progress-log');

    logEl.textContent +=
      '[Retry ' +
      consecutiveErrors +
      '/' +
      MAX_CONSECUTIVE_ERRORS +
      '] ' +
      err.message +
      '\n';

    document
      .getElementById('progress-details')
      .classList.remove('hidden');

    pollTimer = setTimeout(
      pollBuildStatus,
      CONFIG.POLL_INTERVAL_MS
    );
  }
}

// ---- Build success ----
async function onBuildSuccess(run) {
  setProgressTitle('APK Ready!');

  updateStep(
    4,
    'done',
    'All done!'
  );

  try {
    var assets =
      await GitHubAPI.getReleaseAssets(
        buildReleaseId
      );

    var apk = null;
    var keystore = null;
    var properties = null;

    for (var i = 0; i < assets.length; i++) {
      var name = assets[i].name;

      if (name.endsWith('.apk')) {
        apk = assets[i];

      } else if (
        name.endsWith('.jks') ||
        name.endsWith('.keystore')
      ) {
        keystore = assets[i];

      } else if (
        name === 'keystore-properties.txt'
      ) {
        properties = assets[i];
      }
    }

    var html =
      '<div class="result-success">';

    html +=
      '<h2>APK Ready!</h2>';

    html +=
      '<p>Build completed successfully.</p>';

    if (apk) {
      html +=
        '<a class="download-btn" href="' +
        escAttr(apk.browser_download_url) +
        '" download>Download ' +
        escHtml(apk.name) +
        ' (' +
        formatBytes(apk.size) +
        ')</a>';

    } else {
      html +=
        '<p class="status-error">' +
        'APK file not found in release assets. ' +
        'Check the release on GitHub.' +
        '</p>';
    }

    var signingMode =
      document.querySelector(
        'input[name="signing"]:checked'
      );

    if (
      signingMode &&
      signingMode.value === 'generate'
    ) {

      if (keystore || properties) {
        html +=
          '<div class="warning-box">' +
          'Save your signing key! You need the same key for future app updates.' +
          '</div>';
      }

      if (keystore) {
        html +=
          '<a class="download-btn download-btn-secondary" href="' +
          escAttr(keystore.browser_download_url) +
          '" download>Download Keystore</a>';
      }

      if (properties) {
        html +=
          '<a class="download-btn download-btn-secondary" href="' +
          escAttr(properties.browser_download_url) +
          '" download>Download Key Properties</a>';
      }
    }

    html +=
      '<a class="link-btn" href="' +
      escAttr(run.html_url) +
      '" target="_blank" rel="noopener">' +
      'View Build Details on GitHub' +
      '</a>';

    html += '</div>';

    showResultHTML(html);

  } catch (err) {

    var html2 =
      '<div class="result-success">';

    html2 +=
      '<h2>APK Ready!</h2>';

    html2 +=
      '<p>Build completed but download links could not be loaded.</p>';

    html2 +=
      '<a class="link-btn" href="' +
      escAttr(run.html_url) +
      '" target="_blank" rel="noopener">' +
      'View Release on GitHub to download' +
      '</a>';

    html2 += '</div>';

    showResultHTML(html2);
  }
}

// ---- Build failure ----
async function onBuildFailure(run) {
  updateStep(
    1,
    'error',
    'Build failed'
  );

  setProgressTitle('Build Failed');

  var html =
    '<div class="result-error">';

  html +=
    '<h2>Build Failed</h2>';

  html +=
    '<p>Your project could not be compiled. Common causes:</p>';

  html += '<ul>';

  html +=
    '<li>Missing or incorrect <code>build.gradle</code> configuration</li>';

  html +=
    '<li>Missing dependencies or SDK components</li>';

  html +=
    '<li>Source code errors in your project</li>';

  html += '</ul>';

  html +=
    '<a class="link-btn" href="' +
    escAttr(run.html_url) +
    '" target="_blank" rel="noopener">' +
    'View Build Logs on GitHub' +
    '</a>';

  html += '</div>';

  showResultHTML(html);
}

// ---- UI helpers ----
function showSection(id) {
  document
    .getElementById('step-progress')
    .classList.add('hidden');

  document
    .getElementById('step-result')
    .classList.add('hidden');

  document
    .getElementById(id)
    .classList.remove('hidden');
}

function setProgressTitle(t) {
  document
    .getElementById('progress-title')
    .textContent = t;
}

function addStep(cls, text) {
  var div =
    document.createElement('div');

  div.className =
    'progress-step ' +
    (cls || 'pending');

  div.innerHTML =
    '<span class="step-icon"></span>' +
    '<span class="step-text">' +
    escHtml(text) +
    '</span>';

  document
    .getElementById('progress-steps')
    .appendChild(div);
}

function updateStep(index, cls, text) {
  var steps =
    document.querySelectorAll(
      '.progress-step'
    );

  if (!steps[index]) return;

  steps[index].className =
    'progress-step ' + cls;

  var textEl =
    steps[index].querySelector(
      '.step-text'
    );

  if (textEl) {
    textEl.textContent = text;
  }
}

function showResult(
  type,
  title,
  message
) {
  var cls =
    type === 'error'
      ? 'result-error'
      : 'result-success';

  showResultHTML(
    '<div class="' +
    cls +
    '">' +
    '<h2>' +
    escHtml(title) +
    '</h2>' +
    '<p>' +
    escHtml(message) +
    '</p>' +
    '</div>'
  );
}

function showResultHTML(html) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  document
    .getElementById('step-progress')
    .classList.add('hidden');

  var rc =
    document.getElementById(
      'result-content'
    );

  rc.innerHTML = html;

  document
    .getElementById('step-result')
    .classList.remove('hidden');

  // Reset build button
  var btn =
    document.getElementById(
      'btn-build'
    );

  btn.disabled = false;
  btn.textContent = 'BUILD APK';

  selectedFile = null;

  document
    .getElementById('drop-zone')
    .classList.remove('hidden');

  document
    .getElementById('file-info')
    .classList.add('hidden');

  document
    .getElementById('file-input')
    .value = '';
}

function sleep(ms) {
  return new Promise(
    function(r) {
      setTimeout(r, ms);
    }
  );
}

function escHtml(s) {
  var d =
    document.createElement('div');

  d.textContent = s;

  return d.innerHTML;
}

function escAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
