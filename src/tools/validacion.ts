import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Paquete } from "./paquete.js";

const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});

const CentroSchema = z.object({
  centro_costo: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(
    z.object({
      email: z.string(),
      tope: z.number().nonnegative(),
    })
  ),
});

const IvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(),
});

const PagoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number(),
});

export type Hallazgo = {
  codigo: string;
  detalle: string;
  accion: string;
};

export type Validacion = {
  apta: boolean;
  bloqueos: Hallazgo[];
  confirmaciones: Hallazgo[];
  derivados: {
    proveedor?: z.infer<typeof ProveedorSchema>;
    indicador_iva?: string;
    condiciones_pago?: string;
    informados: string[];
  };
  retroactiva: boolean;
};

function normalizar(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizarNit(valor: string): string {
  return valor.split("-")[0]!.replace(/\D/g, "");
}

async function leerMaestro(directory: string, nombre: string): Promise<unknown> {
  const ruta = path.join(
    directory,
    "fixtures",
    "reto-03",
    "maestros",
    nombre
  );
  return JSON.parse(await readFile(ruta, "utf-8"));
}

export async function validarPaquete(
  directory: string,
  paquete: Paquete
): Promise<Validacion> {
  const resultado: Validacion = {
    apta: false,
    bloqueos: [],
    confirmaciones: [],
    derivados: { informados: [] },
    retroactiva: false,
  };

  const bloquear = (codigo: string, detalle: string, accion: string) =>
    resultado.bloqueos.push({ codigo, detalle, accion });

  const confirmar = (codigo: string, detalle: string, accion: string) =>
    resultado.confirmaciones.push({ codigo, detalle, accion });

  const solicitud = paquete.solicitud;

  if (!paquete.correo) {
    bloquear("PAQUETE", "Falta el correo de solicitud", "Solicitar el correo");
  }

  if (!solicitud) {
    bloquear("PAQUETE", "Falta solicitud.json", "Solicitar los datos de compra");
    return resultado;
  }

  const [proveedoresDatos, centrosDatos, ivaDatos, pagosDatos] =
    await Promise.all([
      leerMaestro(directory, "proveedores.json"),
      leerMaestro(directory, "centros-costo.json"),
      leerMaestro(directory, "indicadores-iva.json"),
      leerMaestro(directory, "condiciones-pago.json"),
    ]);

  const proveedores = z.array(ProveedorSchema).parse(proveedoresDatos);
  const centros = z.array(CentroSchema).parse(centrosDatos);
  const indicadores = z.array(IvaSchema).parse(ivaDatos);
  const pagos = z.array(PagoSchema).parse(pagosDatos);

  // RC1: buscar por NIT; solo si falta, buscar por nombre.
  const coincidencias = proveedores.filter((item) =>
    solicitud.proveedor_nit?.trim()
      ? normalizarNit(item.nit) === normalizarNit(solicitud.proveedor_nit)
      : normalizar(item.nombre) === normalizar(solicitud.proveedor_nombre)
  );

  const proveedor = coincidencias.length === 1 ? coincidencias[0] : undefined;

  if (!proveedor || !proveedor.activo) {
    bloquear(
      "RC1",
      "Proveedor inexistente, ambiguo o inactivo",
      "Solicitar registro o revisión del proveedor en el maestro"
    );
  }

  const centro = centros.find(
    (item) => item.centro_costo === solicitud.centro_costo
  );

  const aprobacion = paquete.aprobacion;
  const aprobador = centro?.aprobadores.find(
    (item) =>
      item.email.trim().toLowerCase() ===
      aprobacion?.de.trim().toLowerCase()
  );

  // RC2: evidencia afirmativa y aprobador autorizado.
  if (!aprobacion?.aprobado || !aprobador) {
    bloquear(
      "RC2",
      "No existe aprobación válida de un aprobador autorizado para el centro",
      "Solicitar aprobación al responsable autorizado del centro de costo"
    );
  }

  // RC3: monto dentro del tope del aprobador.
  if (aprobador && solicitud.valor_total > aprobador.tope) {
    bloquear(
      "RC3",
      `Monto ${solicitud.valor_total} supera el tope ${aprobador.tope}`,
      "Solicitar aprobación a una persona con tope suficiente"
    );
  }

  // RC4: centro y subárea deben corresponder.
  if (!centro || !centro.subareas.includes(solicitud.subarea)) {
    bloquear(
      "RC4",
      "Centro de costo o subárea no válidos",
      "Corregir la asignación de centro de costo y subárea"
    );
  }

  // RC5: diferencia máxima del 2 %.
  if (!paquete.cotizacion) {
    confirmar(
      "RC5",
      "No se adjuntó cotización",
      "Confirmar expresamente si se continúa sin cotización"
    );
  } else {
    const diferencia = Math.abs(
      paquete.cotizacion.total - solicitud.valor_total
    );
    if (diferencia / solicitud.valor_total > 0.02) {
      confirmar(
        "RC5",
        `Solicitud: ${solicitud.valor_total}; cotización: ${paquete.cotizacion.total}`,
        "Confirmar continuar con el valor de la solicitud, sin modificarlo"
      );
    }
    if (paquete.cotizacion.moneda !== solicitud.moneda) {
      bloquear(
        "MONEDA",
        "La moneda de la cotización difiere de la solicitud",
        "Solicitar documentos en la misma moneda"
      );
    }
  }

  if (proveedor?.activo) {
    resultado.derivados.proveedor = proveedor;

    // RC6: IVA ausente se deriva, pero requiere confirmación.
    resultado.derivados.indicador_iva =
      solicitud.indicador_iva || proveedor.indicador_iva_default;

    if (!solicitud.indicador_iva) {
      confirmar(
        "RC6",
        `IVA no informado; se propone ${proveedor.indicador_iva_default}`,
        "Confirmar el indicador de IVA derivado del proveedor"
      );
      resultado.derivados.informados.push(
        "Indicador de IVA obtenido del maestro de proveedores"
      );
    }

    // RC7: condiciones de pago ausentes se derivan y se informan.
    resultado.derivados.condiciones_pago =
      solicitud.condiciones_pago || proveedor.condiciones_pago_default;

    if (!solicitud.condiciones_pago) {
      resultado.derivados.informados.push(
        `Condiciones de pago derivadas: ${proveedor.condiciones_pago_default}`
      );
    }

    if (
      !indicadores.some(
        (item) => item.codigo === resultado.derivados.indicador_iva
      )
    ) {
      bloquear("IVA", "Indicador de IVA no registrado", "Revisar el maestro de IVA");
    }

    if (
      !pagos.some(
        (item) => item.codigo === resultado.derivados.condiciones_pago
      )
    ) {
      bloquear(
        "PAGO",
        "Condición de pago no registrada",
        "Revisar el maestro de condiciones de pago"
      );
    }
  }

  // RC8 y RC9: comparar fechas de calendario.
  const fechaSolicitud = solicitud.fecha_solicitud.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaSolicitud) ||
      !Number.isFinite(Date.parse(fechaSolicitud))) {
    bloquear("FECHA", "Fecha de solicitud inválida", "Corregir la fecha");
  }

  if (paquete.factura && paquete.factura.fecha < fechaSolicitud) {
    resultado.retroactiva = true;
    confirmar(
      "RC8",
      `Factura del ${paquete.factura.fecha}, anterior a solicitud del ${fechaSolicitud}`,
      "Confirmar creación de OC retroactiva"
    );
  }

  if (aprobacion && aprobacion.fecha.slice(0, 10) < fechaSolicitud) {
    confirmar(
      "RC9",
      "La aprobación es anterior a la solicitud",
      "Confirmar que la evidencia corresponde a esta compra"
    );
  }

  // RC10: consistencia aritmética con tolerancia de una unidad.
  if (
    Math.abs(
      solicitud.cantidad * solicitud.valor_unitario - solicitud.valor_total
    ) > 1
  ) {
    bloquear(
      "RC10",
      "Cantidad por valor unitario no coincide con el valor total",
      "Solicitar corrección de los valores"
    );
  }

  resultado.apta = resultado.bloqueos.length === 0;
  return resultado;
}