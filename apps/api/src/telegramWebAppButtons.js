export function webAppButton({ text, url }) {
  return { text, style: "primary", web_app: { url } };
}

export function miniAppHomeButton({ miniAppUrl, telegramUserId, language = "ru" }) {
  return webAppButton({
    text: language === "en" ? "📱 Open Mini App" : "📱 Открыть Mini App",
    url: `${miniAppUrl}?telegramUserId=${telegramUserId}`
  });
}
