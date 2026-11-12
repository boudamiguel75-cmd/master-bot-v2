"use strict";

const axios = require("axios");
const log = require("npmlog");

class NeuralHook {
  constructor(config) {
    this.config = config.aiMaster;
    this.memory = new Map(); // Cache mémoire par utilisateur (RAM ultra-rapide)
  }

  /**
   * Vérifie si l'IA doit répondre à ce message
   */
  shouldIntercept(event, prefix) {
    if (!this.config.enabled || !this.config.autoReply.enabled) return false;
    if (!event.body) return false;
    
    // Si c'est une commande (ex: ~ping), on ignore
    if (event.body.startsWith(prefix)) return false;

    // Si c'est un groupe, on vérifie si le bot est mentionné
    if (event.isGroup && this.config.autoReply.groupsOnlyWhenMentioned) {
      const isMentioned = event.mentions && Object.keys(event.mentions).includes(global.GoatBot.botID);
      if (!isMentioned && !event.body.toLowerCase().includes("master")) return false;
    }

    return true;
  }

  /**
   * Génère la réponse via le fournisseur configuré (Mistral par défaut)
   */
  async generateResponse(senderID, text) {
    const providerName = this.config.provider || "mistral";
    const providerConf = this.config.providers[providerName];
    const apiKey = process.env[`${providerName.toUpperCase()}_API_KEY`] || providerConf.apiKey;

    if (!apiKey) {
      log.error("AI_MASTER", `Clé API manquante pour ${providerName}`);
      return "⚠️ Master est en maintenance (clé API manquante).";
    }

    // 1. Gestion de la mémoire (Contexte)
    let history = this.memory.get(senderID) || [];
    history.push({ role: "user", content: text });
    
    // On garde seulement les 20 derniers messages pour ne pas exploser les tokens
    if (history.length > this.config.memory.maxMessages) {
      history = history.slice(-this.config.memory.maxMessages);
    }

    const messages = [
      { role: "system", content: this.config.persona.systemPrompt },
      ...history
    ];

    try {
      let responseText = "";

      // 2. Appel API (Mistral par défaut, format OpenAI compatible)
      if (providerName === "mistral") {
        const res = await axios.post("https://api.mistral.ai/v1/chat/completions", {
          model: providerConf.model,
          messages: messages
        }, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        responseText = res.data.choices[0].message.content;
      } 
      // Tu peux ajouter Groq, OpenRouter, etc. ici avec la même logique
      else if (providerName === "groq") {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
          model: providerConf.model,
          messages: messages
        }, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        responseText = res.data.choices[0].message.content;
      }

      // 3. Sauvegarde en mémoire
      history.push({ role: "assistant", content: responseText });
      this.memory.set(senderID, history);

      return responseText;

    } catch (error) {
      log.error("AI_MASTER", error.message);
      return "❌ Master a rencontré une erreur de réflexion.";
    }
  }
}

module.exports = NeuralHook;
