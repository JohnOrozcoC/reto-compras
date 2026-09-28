import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  OrdenCompraSchema,
  type OrdenCompra,
  type SapAdapter,
} from "./adapter.js";

const RegistroSchema = z.object({
  numero_oc: z.string(),
  fecha: z.string(),
  orden: OrdenCompraSchema,
});

type Registro = z.infer<typeof RegistroSchema>;

export class SapSimulado implements SapAdapter {
  constructor(private directory: string) {}

  private leerOrdenes(): Registro[] {
    const ruta = path.join(this.directory, "out", "sap", "ordenes.jsonl");
    if (!existsSync(ruta)) return [];

    return readFileSync(ruta, "utf-8")
      .split(/\r?\n/)
      .filter((linea) => linea.trim())
      .map((linea) => RegistroSchema.parse(JSON.parse(linea)));
  }

  async consultarProveedor(nit: string) {
    const ruta = path.join(
      this.directory,
      "fixtures",
      "reto-03",
      "maestros",
      "proveedores.json"
    );

    const proveedores = z.array(
      z.object({
        codigo_sap: z.string(),
        nit: z.string(),
        activo: z.boolean(),
      })
    ).parse(JSON.parse(readFileSync(ruta, "utf-8")));

    const proveedor = proveedores.find((item) => item.nit === nit);
    return proveedor
      ? { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo }
      : null;
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const existente = this.leerOrdenes().find(
      (item) => item.orden.referencia.solicitud_id === solicitud_id
    );
    return existente ? { numero_oc: existente.numero_oc } : null;
  }

  async crearOrden(entrada: OrdenCompra) {
    const orden = OrdenCompraSchema.parse(entrada);

    // Lectura y escritura síncronas: no se intercalan en este proceso.
    const registros = this.leerOrdenes();
    const existente = registros.find(
      (item) =>
        item.orden.referencia.solicitud_id === orden.referencia.solicitud_id
    );

    if (existente) {
      return {
        numero_oc: existente.numero_oc,
        fecha: existente.fecha,
      };
    }

    const ultimo = registros.reduce(
      (maximo, item) => Math.max(maximo, Number(item.numero_oc)),
      4500000000
    );

    const registro: Registro = {
      numero_oc: String(ultimo + 1),
      fecha: new Date().toISOString(),
      orden,
    };

    const carpeta = path.join(this.directory, "out", "sap");
    mkdirSync(carpeta, { recursive: true });
    appendFileSync(
      path.join(carpeta, "ordenes.jsonl"),
      JSON.stringify(registro) + "\n",
      "utf-8"
    );

    return {
      numero_oc: registro.numero_oc,
      fecha: registro.fecha,
    };
  }
}