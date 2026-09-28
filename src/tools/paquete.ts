import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CasoSchema = z.string().regex(/^sol-\d{3}$/);

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().min(1),
});

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
});

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

export type Solicitud = z.infer<typeof SolicitudSchema>;

export type Paquete = {
  correo: z.infer<typeof CorreoSchema> | null;
  solicitud: Solicitud | null;
  cotizacion: {
    proveedor: string;
    nit: string | null;
    total: number;
    moneda: string;
    validez_hasta: string | null;
    texto: string;
  } | null;
  aprobacion: {
    de: string;
    fecha: string;
    aprobado: boolean;
    texto: string;
  } | null;
  factura: {
    numero: string;
    fecha: string;
    total: number;
  } | null;
  faltantes: string[];
};

export async function leerOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function extraer(texto: string, patron: RegExp, campo: string): string {
  const valor = texto.match(patron)?.[1]?.trim();
  if (!valor) throw new Error(`No se pudo leer ${campo}`);
  return valor;
}

function totalDocumento(texto: string): number {
  const valor = extraer(
    texto,
    /^TOTAL[^\r\n:]*:\s*(?:COP|USD)\s*([\d.,]+)/im,
    "total del documento"
  );
  // Los fixtures entregados usan puntos como separadores de miles.
  const numero = Number(valor.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(numero)) throw new Error("Total no numérico");
  return numero;
}

export async function leerPaquete(
  directory: string,
  caso: string
): Promise<Paquete> {
  CasoSchema.parse(caso);
  const base = path.join(directory, "fixtures", "reto-03", "solicitudes", caso);

  const nombres = [
    "correo.json",
    "solicitud.json",
    "cotizacion.txt",
    "aprobacion.json",
    "factura.txt",
  ];

  const textos = await Promise.all(
    nombres.map((nombre) => leerOpcional(path.join(base, nombre)))
  );

  const [correo, solicitud, cotizacion, aprobacion, factura] = textos;

  const aprobacionDatos = aprobacion
    ? AprobacionSchema.parse(JSON.parse(aprobacion))
    : null;

  let validezHasta: string | null = null;
  if (cotizacion) {
    const fecha = cotizacion.match(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
    const dias = cotizacion.match(/Validez de la oferta:\s*(\d+)\s*días/i)?.[1];
    if (fecha && dias) {
      const limite = new Date(`${fecha}T00:00:00Z`);
      limite.setUTCDate(limite.getUTCDate() + Number(dias));
      validezHasta = limite.toISOString().slice(0, 10);
    }
  }

  return {
    correo: correo ? CorreoSchema.parse(JSON.parse(correo)) : null,
    solicitud: solicitud
      ? SolicitudSchema.parse(JSON.parse(solicitud))
      : null,
    cotizacion: cotizacion
      ? {
          proveedor: extraer(cotizacion, /^Proveedor:\s*(.+)$/m, "proveedor"),
          nit: cotizacion.match(/^NIT:\s*(.+)$/m)?.[1]?.trim() ?? null,
          total: totalDocumento(cotizacion),
          moneda: extraer(cotizacion, /^TOTAL[^\r\n:]*:\s*(COP|USD)/im, "moneda"),
          validez_hasta: validezHasta,
          texto: cotizacion,
        }
      : null,
    aprobacion: aprobacionDatos
      ? {
          de: aprobacionDatos.de,
          fecha: aprobacionDatos.fecha,
          aprobado:
            /\baprobado\b/i.test(aprobacionDatos.cuerpo) &&
            !/\bno\s+aprobado\b/i.test(aprobacionDatos.cuerpo),
          texto: aprobacionDatos.cuerpo,
        }
      : null,
    factura: factura
      ? {
          numero: extraer(factura, /No\.\s*(\S+)/i, "número de factura"),
          fecha: extraer(
            factura,
            /Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/i,
            "fecha de factura"
          ),
          total: totalDocumento(factura),
        }
      : null,
    faltantes: nombres.filter(
      (nombre, indice) => nombre !== "factura.txt" && !textos[indice]
    ),
  };
}