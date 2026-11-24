window.GDRIVE_CONFIG = {
  clientId: "978083976906-oicde1ab0nnd9d3q1v4hifialbqd3a8g.apps.googleusercontent.com",
  // 與 Google Cloud Console 設定的 redirect URI 完全一致
  redirectUri: "https://microsoft-phi-three.vercel.app/",
  // 完整 Drive 權限（個人測試用）。若要較窄可用 drive.file
  scopes: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email"
  ],
  // Google OAuth endpoints
  authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "/api/token",
};
