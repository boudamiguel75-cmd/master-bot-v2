"use strict";

const axios = require("axios");
const log = require("npmlog");

class AIMaster {
  constructor(config) {
    this.config = config.aiMaster;
    this.memory = new Map();
  }

  shouldReply(event, prefix) {
    if (!this.config.enabled || !this.config.autoReply.enabled) return false;
    if (!event.body || event.body.startsWith(prefix)) return false;
    
    if (event.isGroup && this.config.autoReply.groupsOnlyWhenMentioned) {
      const isMentioned = event.mentions && Object.keys(event.mentions).includes(global.GoatBot.botID);
      if (!isMentioned && !event.body.toLowerCase().includes("master")) return false;
    }
    return true;
  }

  // Récupère la clé API (Env prioritaire, puis config.json)
  getApiKey(providerName) {
    const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];
    if (envKey) return envKey;
    return this.config.providers[providerName]?.apiKey || null;
  }

  async generateReply(senderID, text) {
    // 1. Préparation de l'historique
    let history = this.memory.get(senderID) || [];
    history.push({ role: "user", content: text });
    if (history.length > this.config.memory.maxMessages) {
      history = history.slice(-this.config.memory.maxMessages);
    }

    // 2. Liste des fournisseurs à essayer (le principal + les fallbacks)
    const providersToTry = [this.config.provider, ...(this.config.fallbackProviders || [])];

    for (const providerName of providersToTry) {
      const apiKey = this.getApiKey(providerName);
      
      // Si pas de clé, on passe au suivant
      if (!apiKey && providerName !== "ollama") continue;

      try {
        log.info("AI_MASTER", `Tentative avec ${providerName}...`);
        const responseText = await this.callProvider(providerName, apiKey, history);

        // Si succès, on sauvegarde et on renvoie
        history.push({ role: "assistant", content: responseText });
        this.memory.set(senderID, history);
        return responseText;

      } catch (error) {
        log.warn("AI_MASTER", `Échec avec ${providerName}: ${error.message}`);
        // On continue la boucle pour tester le fallback suivant
      }
    }

    // Si tous les fournisseurs ont échoué
    return "❌ Master est actuellement hors ligne (toutes les API ont échoué).";
  }

  // Appel API selon le fournisseur
  async callProvider(providerName, apiKey, history) {
    const providerConf = this.config.providers[providerName];
    const messages = [
      { role: "system", content: this.config.persona.systemPrompt },
      ...history
    ];

    // Format OpenAI standard (Mistral, Groq, DeepSeek, OpenRouter, OpenAI, Grok)
    if (["mistral", "groq", "deepseek", "openai", "grok", "openrouter"].includes(providerName)) {
      let url = "";
      if (providerName === "mistral") url = "https://api.mistral.ai/v1/chat/completions";
      else if (providerName === "groq") url = "https://api.groq.com/openai/v1/chat/completions";
      else if (providerName === "deepseek") url = "https://api.deepseek.com/chat/completions";
      else if (providerName === "openai") url = "https://api.openai.com/v1/chat/completions";
      else if (providerName === "grok") url = "https://api.x.ai/v1/chat/completions";
      else if (providerName === "openrouter") url = "https://openrouter.ai/api/v1/chat/completions";

      const res = await axios.post(url, {
        model: providerConf.model,
        messages: messages
      }, {
        headers: { 
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/master-charbel", // Requis par OpenRouter
          "X-Title": "Goat Bot V3"
        }
      });
      return res.data.choices[0].message.content;
    }

    // Format Gemini (Google)
    if (providerName === "gemini") {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${providerConf.model}:generateContent?key=${apiKey}`,
        {
          contents: history.map(h => ({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.content }]
          })),
          systemInstruction: { parts: [{ text: this.config.persona.systemPrompt }] }
        }
      );
      return res.data.candidates[0].content.parts[0].text;
    }

    // Format Ollama (Local)
    if (providerName === "ollama") {
      const res = await axios.post(`${providerConf.baseUrl}/api/chat`, {
        model: providerConf.model,
        messages: messages,
        stream: false
      });
      return res.data.message.content;
    }

    throw new Error("Fournisseur non supporté");
  }
}

module.exports = AIMaster;
