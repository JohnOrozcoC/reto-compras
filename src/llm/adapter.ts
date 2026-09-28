export type Llamada = {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
};

export type Mensaje =
  | { role: "user" | "assistant"; content: string }
  | Llamada
  | { type: "function_call_output"; call_id: string; output: string };

export type Definicion = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export interface LlmAdapter {
  enviar(
    instrucciones: string,
    mensajes: Mensaje[],
    herramientas: Definicion[]
  ): Promise<{ texto: string; llamadas: Llamada[]; tokens: number }>;
}