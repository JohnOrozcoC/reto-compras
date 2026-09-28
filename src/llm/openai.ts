import OpenAI from "openai";
import type { LlmAdapter, Mensaje, Definicion } from "./adapter.js";

export class OpenAIAdapter implements LlmAdapter {
  private cliente = new OpenAI({ timeout: 25000, maxRetries: 0 });

  async enviar(
    instrucciones: string,
    mensajes: Mensaje[],
    herramientas: Definicion[]
  ) {
    const respuesta = await this.cliente.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: instrucciones,
      input: mensajes,
      store: false,
      max_output_tokens: 3000,
      parallel_tool_calls: false,
      tools: herramientas.map((item) => ({
        type: "function" as const,
        name: item.name,
        description: item.description,
        parameters: item.parameters,
        strict: false,
      })),
    });

    const llamadas = respuesta.output
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        type: "function_call" as const,
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments,
      }));

    return {
      texto: respuesta.output_text,
      llamadas,
      tokens: respuesta.usage?.total_tokens ?? 0,
    };
  }
}