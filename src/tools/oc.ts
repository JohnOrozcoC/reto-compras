import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CasoSchema, leerPaquete } from "./paquete.js";
import { validarPaquete, type Validacion } from "./validacion.js";
import { construirPayload, generarEvidencia } from "./construccion.js";
import { OrdenCompraSchema } from "../sap/adapter.js";
import { SapSimulado } from "../sap/mock.js";

export type Contexto = {
  directory: string;
  sessionId: string;
};

const casoArg = CasoSchema.describe("Carpeta de solicitud, por ejemplo sol-001");
const objetoArg = z.record(z.string(), z.unknown());

type Pendiente = {
  caso: string;
  huella: string;
};

const pendientes = new Map<string, Pendiente>();
const autorizaciones = new Map<string, Pendiente>();

function huella(valor: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(valor))
    .digest("hex");
}

// Solo el servidor o el demo llaman esta función.
// No se expone como herramienta al modelo.
export function confirmarPendiente(sessionId: string): string | null {
  const pendiente = pendientes.get(sessionId);
  if (!pendiente) return null;

  autorizaciones.set(sessionId, pendiente);
  pendientes.delete(sessionId);
  return pendiente.caso;
}

export function obtenerPendiente(sessionId: string) {
  const pendiente = pendientes.get(sessionId);
  return pendiente ? { caso: pendiente.caso } : null;
}

async function envolver(operacion: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify({ ok: true, data: await operacion() });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Error inesperado",
    });
  }
}

function celda(valor: unknown): string {
  const texto = typeof valor === "string" ? valor : JSON.stringify(valor);
  return `"${texto.replace(/"/g, '""')}"`;
}

async function registrarControl(
  ctx: Contexto,
  solicitudId: string,
  resultado: string,
  validacion: Validacion,
  numero = ""
) {
  const carpeta = path.join(ctx.directory, "out");
  await mkdir(carpeta, { recursive: true });
  const ruta = path.join(carpeta, "control.csv");

  // wx crea el encabezado únicamente si el archivo no existe.
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      ruta,
      "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n",
      { flag: "wx" }
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }

  await appendFile(
    ruta,
    [
      solicitudId,
      resultado,
      numero,
      validacion.retroactiva,
      validacion.bloqueos,
      validacion.confirmaciones,
      new Date().toISOString(),
    ].map(celda).join(",") + "\n"
  );
}

export const leer_paquete = {
  description: "Lee y normaliza los documentos originales de una solicitud.",
  args: { caso: casoArg },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return envolver(async () =>
      leerPaquete(ctx.directory, CasoSchema.parse(args.caso))
    );
  },
};

export const validar = {
  description: "Valida una solicitud contra los maestros y devuelve bloqueos y confirmaciones.",
  args: {
    caso: casoArg,
    paquete: objetoArg.describe("Paquete obtenido con oc_leer_paquete"),
  },
  async execute(
    args: { caso: string; paquete: unknown },
    ctx: Contexto
  ): Promise<string> {
    return envolver(async () => {
      // Volvemos a la fuente para impedir alteraciones del modelo.
      const paquete = await leerPaquete(ctx.directory, args.caso);
      const validacion = await validarPaquete(ctx.directory, paquete);

      if (!validacion.apta || validacion.confirmaciones.length) {
        await registrarControl(
          ctx,
          paquete.solicitud?.solicitud_id ?? args.caso,
          validacion.apta ? "PENDIENTE" : "BLOQUEADA",
          validacion
        );
      }

      return validacion;
    });
  },
};

export const construir_payload = {
  description: "Construye la OC desde las fuentes originales y guarda su trazabilidad.",
  args: {
    caso: casoArg,
    paquete: objetoArg.describe("Paquete leído por la herramienta"),
    derivados: objetoArg.describe("Datos derivados por oc_validar"),
  },
  async execute(
    args: { caso: string; paquete: unknown; derivados: unknown },
    ctx: Contexto
  ): Promise<string> {
    return envolver(async () => {
      const resultado = await construirPayload(ctx.directory, args.caso);

      if (resultado.validacion.confirmaciones.length) {
        const pendiente = {
          caso: args.caso,
          huella: huella(resultado.payload),
        };

        const autorizada = autorizaciones.get(ctx.sessionId);
        if (
          autorizada?.caso !== pendiente.caso ||
          autorizada.huella !== pendiente.huella
        ) {
          autorizaciones.delete(ctx.sessionId);
          pendientes.set(ctx.sessionId, pendiente);
        }
      }

      return resultado;
    });
  },
};

export const generar_evidencia = {
  description: "Genera el TXT del correo de aprobación con su huella SHA256.",
  args: { caso: casoArg },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return envolver(async () => generarEvidencia(ctx.directory, args.caso));
  },
};

export const crear = {
  description: "Crea una OC validada; las excepciones exigen confirmación humana registrada.",
  args: {
    caso: casoArg,
    payload: objetoArg.describe("Payload exacto obtenido con oc_construir_payload"),
    confirmado: z.boolean().optional().describe(
      "Indica que el usuario confirmó; el backend verifica la autorización"
    ),
  },
  async execute(
    args: { caso: string; payload: unknown; confirmado?: boolean },
    ctx: Contexto
  ): Promise<string> {
    return envolver(async () => {
      const paquete = await leerPaquete(ctx.directory, args.caso);
      const validacion = await validarPaquete(ctx.directory, paquete);
      const solicitudId = paquete.solicitud?.solicitud_id ?? args.caso;

      if (!validacion.apta) {
        await registrarControl(ctx, solicitudId, "BLOQUEADA", validacion);
        throw new Error(
          validacion.bloqueos.map((item) => item.detalle).join("; ")
        );
      }

      const preparado = await construirPayload(ctx.directory, args.caso);
      const recibido = OrdenCompraSchema.parse(args.payload);

      if (!isDeepStrictEqual(recibido, preparado.payload)) {
        throw new Error("El payload cambió respecto a las fuentes; vuelve a prepararlo");
      }

      if (validacion.confirmaciones.length) {
        const autorizada = autorizaciones.get(ctx.sessionId);
        const huellaActual = huella(preparado.payload);

        if (
          !args.confirmado ||
          autorizada?.caso !== args.caso ||
          autorizada.huella !== huellaActual
        ) {
          pendientes.set(ctx.sessionId, {
            caso: args.caso,
            huella: huellaActual,
          });
          await registrarControl(ctx, solicitudId, "PENDIENTE", validacion);
          throw new Error("Se requiere confirmación humana explícita en esta sesión");
        }
      }

      const orden = preparado.payload;
      for (const excepcion of orden.excepciones) {
        excepcion.confirmado_por = ctx.sessionId;
      }

      autorizaciones.delete(ctx.sessionId);
      pendientes.delete(ctx.sessionId);

      const sap = new SapSimulado(ctx.directory);
      const existente = await sap.buscarOrdenPorReferencia(solicitudId);
      const creada = await sap.crearOrden(orden);

      await registrarControl(
        ctx,
        solicitudId,
        existente ? "EXISTENTE" : "CREADA",
        validacion,
        creada.numero_oc
      );

      return {
        ...creada,
        idempotente: Boolean(existente),
        evidencia: preparado.evidencia.ruta,
      };
    });
  },
};

export const herramientas = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
};