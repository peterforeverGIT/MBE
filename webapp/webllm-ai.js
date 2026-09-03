let engine, webllm;

async function initWebLLM() {
    if (!webllm) webllm = await import('https://esm.run/@mlc-ai/web-llm@0.2.83');
    if (!engine) engine = await webllm.CreateMLCEngine(
        "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
        { initProgressCallback: (r) => console.log(`[WebLLM] ${r.text} (${Math.round(r.progress * 100)}%)`) }
    );
    return engine;
}

// Drop-in replacement for callMistralAPI
window.callAI = async (sys, prompt) => {
    await initWebLLM();
    const messages = [];
    if (sys) messages.push({ role: "system", content: sys });
    messages.push({ role: "user", content: prompt });

    const stream = await engine.chat.completions.create({
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: 1000
    });

    let response = "";
    for await (const chunk of stream) {
        response += chunk.choices?.[0]?.delta?.content || "";
    }

    // Return in Mistral API format for compatibility
    return { choices: [{ message: { content: response } }] };
};
