// Auth module for ListenTogether
const Auth = {
    user: null,

    // Check response for auto-renewed token
    _checkTokenRenewal(res) {
        const newToken = res.headers.get('X-New-Token');
        if (newToken) {
            localStorage.setItem('token', newToken);
        }
    },

    async init() {
        try {
            const res = await fetch('/api/auth/me');
            this._checkTokenRenewal(res);
            if (res.ok) {
                const data = await res.json();
                this.user = data;
                this.onLogin(data);
                return true;
            }
        } catch (e) { console.log('Not logged in'); }
        this.showLoginScreen();
        return false;
    },

    showLoginScreen() {
        document.getElementById('loginScreen').classList.add('active');
        document.getElementById('home').classList.remove('active');
        document.getElementById('room').classList.remove('active');
    },

    onLogin(user) {
        this.user = user;
        document.getElementById('loginScreen').classList.remove('active');
        document.getElementById('home').classList.add('active');

        // Role badge
        let badge = '';
        if (user.role === 'owner') badge = '👑 ';
        else if (user.role === 'admin') badge = '⭐ ';
        document.getElementById('currentUsername').textContent = badge + user.username;
        document.getElementById('userBar').classList.remove('hidden');

        // Show/hide create button based on role
        const createBtn = document.getElementById('createBtn');
        const createDivider = document.getElementById('createDivider');
        if (user.role === 'user') {
            createBtn.classList.add('hidden');
            createDivider.classList.add('hidden');
        } else {
            createBtn.classList.remove('hidden');
            createDivider.classList.remove('hidden');
        }

        // Show library button for admin/owner
        const libraryBtn = document.getElementById('libraryBtn');
        if (user.role === 'admin' || user.role === 'owner') {
            libraryBtn.classList.remove('hidden');
        } else {
            libraryBtn.classList.add('hidden');
        }

        // Show admin button for owner
        const adminBtn = document.getElementById('adminBtn');
        if (user.role === 'owner') {
            adminBtn.classList.remove('hidden');
        } else {
            adminBtn.classList.add('hidden');
        }
    },

    updateUIForRole(role) {
        this.user.role = role;
        this.onLogin(this.user);
    },

    async login(username, password) {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败');
        if (data.needChangePassword) {
            alert('默认密码，请尽快修改密码！');
        }
        this.onLogin(data.user);
        return data;
    },

    async register(username, password) {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '注册失败');
        this.onLogin(data.user);
        return data;
    },

    async logout() {
        await fetch('/api/auth/logout', { method: 'POST' });
        this.user = null;
        document.getElementById('userBar').classList.add('hidden');
        this.showLoginScreen();
        if (window.ws) { try { window.ws.close(); } catch(e) {} }
    },

    async changePassword(oldPassword, newPassword) {
        const res = await fetch('/api/auth/password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_password: oldPassword, new_password: newPassword })
        });
        this._checkTokenRenewal(res);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '修改失败');
        return data;
    },

    async changeUsername(newUsername, password) {
        const res = await fetch('/api/auth/username', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_username: newUsername, password })
        });
        this._checkTokenRenewal(res);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '修改失败');
        // Update local user info
        this.user.username = data.username;
        this.onLogin(this.user);
        return data;
    },

    // Admin functions removed - now on separate /admin page
};

// DOM setup
document.addEventListener('DOMContentLoaded', () => {
    const loginTab = document.getElementById('loginTab');
    const registerTab = document.getElementById('registerTab');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const authError = document.getElementById('authError');

    loginTab.onclick = () => {
        loginTab.classList.add('active'); registerTab.classList.remove('active');
        loginForm.classList.remove('hidden'); registerForm.classList.add('hidden');
        authError.textContent = '';
    };
    registerTab.onclick = () => {
        registerTab.classList.add('active'); loginTab.classList.remove('active');
        registerForm.classList.remove('hidden'); loginForm.classList.add('hidden');
        authError.textContent = '';
    };

    document.getElementById('loginSubmit').onclick = async () => {
        authError.textContent = '';
        const u = document.getElementById('loginUsername').value.trim();
        const p = document.getElementById('loginPassword').value;
        if (!u || !p) { authError.textContent = '请填写用户名和密码'; return; }
        try { await Auth.login(u, p); } catch (e) { authError.textContent = e.message; }
    };

    document.getElementById('registerSubmit').onclick = async () => {
        authError.textContent = '';
        const u = document.getElementById('regUsername').value.trim();
        const p = document.getElementById('regPassword').value;
        const p2 = document.getElementById('regPassword2').value;
        if (!u || !p) { authError.textContent = '请填写用户名和密码'; return; }
        if (p !== p2) { authError.textContent = '两次密码不一致'; return; }
        try { await Auth.register(u, p); } catch (e) { authError.textContent = e.message; }
    };

    ['loginUsername', 'loginPassword'].forEach(id => {
        document.getElementById(id).onkeypress = e => { if (e.key === 'Enter') document.getElementById('loginSubmit').click(); };
    });
    ['regUsername', 'regPassword', 'regPassword2'].forEach(id => {
        document.getElementById(id).onkeypress = e => { if (e.key === 'Enter') document.getElementById('registerSubmit').click(); };
    });

    document.getElementById('logoutBtn').onclick = () => Auth.logout();

    // Settings panel
    document.getElementById('settingsBtn').onclick = async () => {
        const overlay = document.getElementById('settingsOverlay');
        overlay.classList.remove('hidden');
        document.getElementById('usernameError').textContent = '';
        document.getElementById('passwordError').textContent = '';
        document.getElementById('newUsernameInput').value = '';
        document.getElementById('usernamePassword').value = '';
        document.getElementById('oldPwInput').value = '';
        document.getElementById('newPwInput').value = '';
        document.getElementById('confirmPwInput').value = '';
        // Load user info
        try {
            const res = await fetch('/api/auth/me');
            if (res.ok) {
                const data = await res.json();
                document.getElementById('settingsUsername').textContent = data.username;
                document.getElementById('settingsUID').textContent = String(data.uid).padStart(5,'0');
                const suidEl = document.getElementById('settingsSUID');
                if (suidEl) suidEl.textContent = data.suid ? 'SUID: ' + String(data.suid).padStart(3,'0') : '';
                const roleMap = { owner: '👑 站长', admin: '⭐ 管理员', user: '普通用户' };
                document.getElementById('settingsRole').textContent = roleMap[data.role] || data.role;
                const d = new Date(data.created_at);
                document.getElementById('settingsCreatedAt').textContent = d.toLocaleString('zh-CN');
            }
        } catch (e) {}
    };
    document.getElementById('settingsClose').onclick = () => {
        document.getElementById('settingsOverlay').classList.add('hidden');
    };
    document.getElementById('settingsOverlay').onclick = (e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
    };

    // Change username
    document.getElementById('changeUsernameBtn').onclick = async () => {
        const errEl = document.getElementById('usernameError');
        errEl.textContent = '';
        errEl.className = 'settings-error';
        const newName = document.getElementById('newUsernameInput').value.trim();
        const pw = document.getElementById('usernamePassword').value;
        if (!newName) { errEl.textContent = '请输入新用户名'; return; }
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(newName)) { errEl.textContent = '用户名需要3-20个字符，只能包含字母、数字和下划线'; return; }
        if (!pw) { errEl.textContent = '请输入当前密码'; return; }
        try {
            await Auth.changeUsername(newName, pw);
            errEl.textContent = '修改成功！';
            errEl.className = 'settings-success';
            document.getElementById('settingsUsername').textContent = newName;
            document.getElementById('newUsernameInput').value = '';
            document.getElementById('usernamePassword').value = '';
        } catch (e) { errEl.textContent = e.message; }
    };

    // Change password
    document.getElementById('changePasswordBtn').onclick = async () => {
        const errEl = document.getElementById('passwordError');
        errEl.textContent = '';
        errEl.className = 'settings-error';
        const oldPw = document.getElementById('oldPwInput').value;
        const newPw = document.getElementById('newPwInput').value;
        const confirmPw = document.getElementById('confirmPwInput').value;
        if (!oldPw) { errEl.textContent = '请输入旧密码'; return; }
        if (newPw.length < 6) { errEl.textContent = '新密码至少6个字符'; return; }
        if (newPw !== confirmPw) { errEl.textContent = '两次密码不一致'; return; }
        try {
            await Auth.changePassword(oldPw, newPw);
            errEl.textContent = '密码修改成功！';
            errEl.className = 'settings-success';
            document.getElementById('oldPwInput').value = '';
            document.getElementById('newPwInput').value = '';
            document.getElementById('confirmPwInput').value = '';
        } catch (e) { errEl.textContent = e.message; }
    };

    // Library button navigates to /library page
    document.getElementById('libraryBtn').onclick = () => {
        window.open('/library', '_blank');
    };

    // Admin button navigates to /admin page
    document.getElementById('adminBtn').onclick = () => {
        window.open('/admin', '_blank');
    };

    Auth.init();
});

window.Auth = Auth;
