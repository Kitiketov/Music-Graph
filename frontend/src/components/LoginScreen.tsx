import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Music2, Network, RefreshCcw, ShieldCheck, Users } from "lucide-react";
import { api, setToken } from "../api/client";
import { LEGAL_VERSION, legalSummary, privacyText, termsText } from "../legal";
import type { QrStartResponse, User } from "../types/api";

type Props = {
  onLogin: (user: User) => void;
};

const serviceCards = [
  {
    title: "Музыкальная карта",
    text: "Пузырьки — это артисты из твоих лайков, истории, знакомых треков и Моей волны. Чем больше знакомых треков, тем крупнее артист."
  },
  {
    title: "Коллабы и связи",
    text: "Зеленые линии показывают треки, которые ты реально слышал. Синие связи можно включить отдельно — это найденные коллабы из дискографии."
  },
  {
    title: "Похожие артисты",
    text: "Похожие артисты добавляются только если Яндекс видит у тебя больше 0 знакомых треков, чтобы граф не превращался в случайную кашу."
  },
  {
    title: "Друзья и сравнение",
    text: "Можно обменяться приглашением, открыть граф друга и увидеть общих артистов, пересечение вкусов и общие музыкальные острова."
  }
];

const serviceSteps = [
  "Входишь через QR-страницу Яндекса.",
  "Сервис синхронизирует лайки, историю, знакомые треки артистов и связи.",
  "Граф можно фильтровать по глубине, коллабам, похожим артистам и силе отталкивания."
];

export function LoginScreen({ onLogin }: Props) {
  const qrWindowRef = useRef<Window | null>(null);
  const [qr, setQr] = useState<QrStartResponse | null>(null);
  const [status, setStatus] = useState("Прими соглашение, чтобы создать QR-вход");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!qr) return undefined;

    let cancelled = false;
    let timer: number | undefined;

    timer = window.setInterval(async () => {
      try {
        const state = await api.qrStatus(qr.session_id);
        if (cancelled) return;

        if (state.status === "confirmed" && state.access_token && state.user) {
          window.clearInterval(timer);
          closeQrWindow();
          setToken(state.access_token);
          onLogin(state.user);
          return;
        }

        if (state.status === "failed" || state.status === "expired") {
          window.clearInterval(timer);
          setError(state.message ?? "QR-сессия входа не завершилась");
          return;
        }

        setStatus("Жду подтверждение QR-входа в Яндексе...");
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Не удалось проверить QR-вход");
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
      closeQrWindow();
    };
  }, [onLogin, qr]);

  function closeQrWindow() {
    const qrWindow = qrWindowRef.current;
    if (qrWindow && !qrWindow.closed) {
      qrWindow.close();
    }
    qrWindowRef.current = null;
  }

  function openQrWindow() {
    if (!qr) return;

    const width = 520;
    const height = 760;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    const features = [
      "popup=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      "toolbar=no",
      "menubar=no",
      "status=no",
      "scrollbars=yes",
      "resizable=yes"
    ].join(",");

    const popup = window.open(qr.qr_url, "musicGraphYandexQrLogin", features);
    if (popup) {
      qrWindowRef.current = popup;
      popup.focus();
      setStatus("QR открыт отдельным окном. Жду подтверждение входа...");
      return;
    }

    setError("Браузер заблокировал отдельное окно. Разреши pop-up или открой QR-ссылку ниже.");
  }

  async function startQrLogin() {
    if (!accepted) {
      setError("Сначала нужно принять пользовательское соглашение и политику обработки данных");
      return;
    }

    closeQrWindow();
    setStarting(true);
    setError(null);
    setCopied(null);
    setQr(null);
    setStatus("Создаем QR-страницу авторизации Яндекса...");

    try {
      const started = await api.startQr({
        accepted_terms: true,
        terms_version: LEGAL_VERSION,
        privacy_version: LEGAL_VERSION
      });
      setQr(started);
      setStatus("Открой QR отдельным окном и подтверди вход");
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Не удалось создать QR-вход через Яндекс");
    } finally {
      setStarting(false);
    }
  }

  async function copyQrLink() {
    if (!qr) return;

    try {
      await navigator.clipboard.writeText(qr.qr_url);
      setCopied("QR-ссылка скопирована");
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Не удалось скопировать QR-ссылку. Открой ее кнопкой ниже.");
    }
  }

  return (
    <main className="login-shell">
      <section className="login-visual" aria-hidden="true">
        <div className="visual-copy">
          <p className="eyebrow">Music Graph</p>
          <h2>Твой вкус как сеть артистов</h2>
          <p>
            Не просто список любимых треков, а живая карта: кто с кем связан, кого ты уже знаешь
            и где рядом спрятаны новые коллабы.
          </p>
          <div className="visual-stats">
            <span>лайки</span>
            <span>волна</span>
            <span>коллабы</span>
          </div>
        </div>
        <div className="vinyl-disc">
          <div className="vinyl-label">
            <Music2 size={38} />
          </div>
        </div>
        <div className="signal-lines">
          <span />
          <span />
          <span />
        </div>
      </section>

      <section className="login-panel">
        <div>
          <p className="eyebrow">Music Graph</p>
          <h1>QR-вход Яндекс</h1>
          <p className="muted">
            Сначала прими условия хранения музыкальных данных. Потом открой QR-страницу Яндекса,
            отсканируй QR и оставь этот сайт открытым.
          </p>
        </div>

        <section className="service-overview" aria-label="Что делает Music Graph">
          <div className="overview-heading">
            <Network size={20} />
            <div>
              <h2>Что это за сервис</h2>
              <p>Music Graph превращает твой аккаунт Яндекс Музыки в интерактивный граф артистов.</p>
            </div>
          </div>

          <div className="overview-grid">
            {serviceCards.map((card) => (
              <article className="overview-card" key={card.title}>
                <strong>{card.title}</strong>
                <p>{card.text}</p>
              </article>
            ))}
          </div>

          <div className="service-flow">
            <div className="flow-title">
              <Users size={18} />
              <strong>Как это работает</strong>
            </div>
            {serviceSteps.map((step, index) => (
              <p key={step}>
                <span>{index + 1}</span>
                {step}
              </p>
            ))}
          </div>

          <div className="privacy-note">
            <ShieldCheck size={18} />
            <p>
              Токены хранятся зашифрованно, данные можно удалить кнопкой в приложении. Перед входом ниже нужно принять
              соглашение, потому что сервис сохраняет музыкальные данные для построения графа.
            </p>
          </div>
        </section>

        <section className="agreement-card">
          <div className="agreement-heading">
            <strong>Соглашение и обработка данных</strong>
            <span>версия {LEGAL_VERSION}</span>
          </div>
          <ul>
            {legalSummary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <button className="text-action" type="button" onClick={() => setShowLegal((value) => !value)}>
            {showLegal ? "Скрыть полный текст" : "Показать полный текст"}
          </button>
          {showLegal && (
            <div className="legal-text">
              <h2>Пользовательское соглашение</h2>
              {termsText.map((section) => (
                <section key={section.title}>
                  <h3>{section.title}</h3>
                  <p>{section.body}</p>
                </section>
              ))}
              <h2>Политика обработки данных</h2>
              {privacyText.map((section) => (
                <section key={section.title}>
                  <h3>{section.title}</h3>
                  <p>{section.body}</p>
                </section>
              ))}
            </div>
          )}
          <label className="agreement-check">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
            <span>Я принимаю пользовательское соглашение и политику обработки данных</span>
          </label>
        </section>

        <div className="login-status">
          <span className={error ? "status-dot error" : "status-dot"} />
          <span>{error ?? status}</span>
        </div>

        {qr ? (
          <div className="qr-login-box">
            <button className="primary-action yandex-action" onClick={openQrWindow}>
              <ExternalLink size={18} />
              Открыть QR отдельным окном
            </button>

            <a
              className="secondary-action yandex-action"
              href={qr.qr_url}
              target="_blank"
              rel="noreferrer"
              onClick={() => setStatus("Жду подтверждение QR-входа в Яндексе...")}
            >
              <ExternalLink size={18} />
              Открыть QR-ссылку здесь
            </a>

            <button className="secondary-action" onClick={() => void copyQrLink()}>
              <Copy size={17} />
              Скопировать QR-ссылку
            </button>

            <p className="muted small">
              Если открылось вкладкой, значит браузер запрещает pop-up окна для этой страницы.
              После успешного входа отдельное окно закроется автоматически.
            </p>

            {copied && <p className="copy-status">{copied}</p>}
          </div>
        ) : (
          <button className="primary-action" disabled={!accepted || starting} onClick={() => void startQrLogin()}>
            {starting ? "Создаем QR-вход..." : "Принять и создать QR"}
          </button>
        )}

        {qr && (
          <button className="secondary-action" disabled={!accepted || starting} onClick={() => void startQrLogin()}>
            <RefreshCcw size={18} />
            Создать новый QR
          </button>
        )}
      </section>
    </main>
  );
}
