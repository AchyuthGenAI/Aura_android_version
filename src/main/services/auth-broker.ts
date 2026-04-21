import http from "node:http";
import { shell } from "electron";
import { AuthService } from "./auth-service";

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId: string;
}

export class AuthBroker {
  private server: http.Server | null = null;
  private readonly port = 34567;
  private readonly host = "localhost";

  constructor(private authService: AuthService) {}

  public async authenticateExternal(config: FirebaseConfig): Promise<{ email: string }> {
    return new Promise((resolve, reject) => {
      this.stop();

      let timeout: NodeJS.Timeout;

      this.server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === "/callback" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const data = JSON.parse(body) as { email?: string };
              if (data.email) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true }));
                this.authService.signInWithGoogle(data.email);
                clearTimeout(timeout);
                this.stop();
                resolve({ email: data.email });
              } else {
                res.writeHead(400);
                res.end();
              }
            } catch {
              res.writeHead(400);
              res.end();
            }
          });
          return;
        }

        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(this.getHtmlPayload(config));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.listen(this.port, this.host, () => {
        shell.openExternal(`http://${this.host}:${this.port}/`).catch(err => {
          this.stop();
          reject(err as Error);
        });
      });

      this.server.on("error", (err) => {
        reject(new Error(`Auth Broker failed to start: ${err.message}`));
        this.stop();
      });

      timeout = setTimeout(() => {
        this.stop();
        reject(new Error("Authentication timed out. Please try again."));
      }, 3 * 60 * 1000);
    });
  }

  private stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private getHtmlPayload(config: FirebaseConfig): string {
    const callbackUrl = `http://${this.host}:${this.port}/callback`;
    const configJson = JSON.stringify(config);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Aura Desktop — Google Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 100vh; background: #09090f; color: white;
    }
    .card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 48px 40px;
      text-align: center;
      max-width: 420px;
      width: 90%;
    }
    .logo {
      width: 56px; height: 56px;
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      border-radius: 16px;
      margin: 0 auto 24px;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #a1a1aa; margin-bottom: 32px; line-height: 1.5; }
    .btn-google {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      width: 100%; padding: 14px 20px;
      background: white; color: #1f1f1f;
      border: none; border-radius: 10px;
      font-size: 15px; font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .btn-google:hover { background: #f3f3f3; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .btn-google:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { margin-top: 24px; font-size: 13px; min-height: 20px; }
    .status.loading { color: #a855f7; }
    .status.success { color: #34d399; }
    .status.error { color: #f87171; }
    .spinner {
      display: inline-block; width: 16px; height: 16px;
      border: 2px solid rgba(168,85,247,0.2);
      border-top-color: #a855f7;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#x2736;</div>
    <h1>Sign in to Aura</h1>
    <p class="subtitle">Click below to authenticate with your Google account. Your active Chrome session will be used automatically.</p>

    <button class="btn-google" id="signInBtn" onclick="startAuth()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </button>

    <div class="status" id="status"></div>
  </div>

  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
    import { getAuth, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js";

    const firebaseConfig = ${configJson};
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();

    window.startAuth = async function() {
      const btn = document.getElementById("signInBtn");
      const status = document.getElementById("status");

      btn.disabled = true;
      status.className = "status loading";
      status.innerHTML = '<span class="spinner"></span>Opening Google account picker…';

      try {
        const result = await signInWithPopup(auth, provider);
        const email = result.user.email;
        if (!email) throw new Error("Google did not return an email address.");

        status.innerHTML = '<span class="spinner"></span>Verifying with Aura Desktop…';

        const response = await fetch("${callbackUrl}", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });

        if (response.ok) {
          document.querySelector("h1").innerText = "Authentication Complete";
          document.querySelector(".subtitle").style.display = "none";
          status.className = "status success";
          status.innerHTML = '<div style="margin-top: 10px; font-size: 15px; font-weight: 500;">✓ Connected as ' + email + '</div><div style="margin-top: 12px; font-size: 13px; color: #9ca3af;">Aura Desktop has securely received your session.<br>You may now safely close this browser tab.</div>';
          btn.style.display = "none";
          
          setTimeout(() => {
            try { window.close(); } catch (e) {}
          }, 2500);
        } else {
          throw new Error("Aura Desktop rejected the token.");
        }
      } catch (err) {
        btn.disabled = false;
        status.className = "status error";
        status.textContent = (err && err.message) ? err.message : "Authentication failed.";
      }
    };
  </script>
</body>
</html>`;
  }
}
