# Notes AI — CRONZPH

AI-powered notes organizer. Built with Groq (Llama), Firebase, and vanilla JS.

## Project Structure

```
notes-ai/
├── api/
│   ├── config.js       ← Returns Firebase config from env vars
│   └── groq.js         ← Proxies Groq API calls (keeps key secret)
├── index.html          ← Landing page (public notes viewer)
├── auth.html           ← Login / Sign up page
├── app.html            ← Main app (requires auth)
├── manifest.json       ← PWA manifest (Android install)
├── sw.js               ← Service worker (offline)
├── .env.example        ← Copy to .env.local for local dev
└── vercel.json         ← Routing config
```

## Pages

| Page | File | Access |
|---|---|---|
| Landing | `index.html` | Public — shows all notes, hero, features |
| Auth | `auth.html` | Public — login & signup, redirects to app on success |
| App | `app.html` | Auth-only — auto-redirects to `auth.html` if not logged in |

## AI Auto-Category

Categories are **fully AI-generated** — no manual selection needed. When you paste notes, Groq (Llama 3.3 70B) analyzes the content and automatically assigns the most relevant category. Examples: `IT`, `STUDY`, `FREELANCE`, `CRYPTO`, `PERSONAL`, `HEALTH`, `BUSINESS`, `DESIGN`, `LANGUAGE`, `FOOD`, `TRAVEL`, `FINANCE`, `SCIENCE`, `ART`, or any other category the AI deems appropriate.

Unknown AI-generated categories are automatically assigned a dynamic color in the UI.

## Deploy to Vercel

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/CRONZPH/notes-ai.git
git push -u origin main
```

### 2. Import in Vercel
Go to vercel.com → New Project → Import your repo.

### 3. Add Environment Variables
In Vercel Dashboard → Your Project → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq key from console.groq.com |
| `FIREBASE_API_KEY` | From Firebase Console → Project Settings |
| `FIREBASE_AUTH_DOMAIN` | `your-project.firebaseapp.com` |
| `FIREBASE_DATABASE_URL` | `https://your-project-default-rtdb.firebaseio.com` |
| `FIREBASE_PROJECT_ID` | `your-project` |
| `FIREBASE_STORAGE_BUCKET` | `your-project.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | From Firebase Console |
| `FIREBASE_APP_ID` | From Firebase Console |

### 4. Firebase Setup
In Firebase Console:
- **Authentication** → Sign-in method → Enable **Email/Password**
- **Realtime Database** → Create database → Rules:
```json
{
  "rules": {
    "notes": {
      ".read": true,
      ".write": "auth != null"
    }
  }
}
```

### 5. Redeploy
After adding env vars, Vercel will auto-redeploy. Done! 🎉

## Local Development
```bash
npm i -g vercel
cp .env.example .env.local
# Fill in your values in .env.local
vercel dev
```