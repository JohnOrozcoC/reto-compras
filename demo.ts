import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
  confirmarPendiente,
} from "./src/tools/oc.js";

type Respuesta = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

function interpretar(texto: string): Respuesta {
  return JSON.parse(texto) as Respuesta;
}

const directory = process.cwd();

// Ejecutar el demo con el servidor detenido: limpia las salidas anteriores.
await rm(`${directory}/out`, { recursive: true, force: true });

for (let numero = 1; numero <= 6; numero++) {
  const caso = `sol-${String(numero).padStart(3, "0")}`;
  const ctx = { directory, sessionId: `demo-${caso}` };

  const lectura = interpretar(await leer_paquete.execute({ caso }, ctx));
  assert.equal(lectura.ok, true);

  const revision = interpretar(
    await validar.execute({ caso, paquete: lectura.data }, ctx)
  );
  assert.equal(revision.ok, true);

  const resultado = revision.data as {
    apta: boolean;
    bloqueos: Array<{ codigo: string }>;
    confirmaciones: Array<{ codigo: string }>;
    derivados: unknown;
    retroactiva: boolean;
  };

  assert.equal(resultado.apta, ![2, 3].includes(numero));
  assert.equal(resultado.retroactiva, numero === 5);

  const esperado = numero === 4 ? ["RC5"]
    : numero === 5 ? ["RC8"]
    : numero === 6 ? ["RC6"] : [];

  assert.deepEqual(
    resultado.confirmaciones.map((item) => item.codigo),
    esperado
  );

  if (!resultado.apta) {
    assert.ok(resultado.bloqueos.some(
      (item) => item.codigo === (numero === 2 ? "RC1" : "RC2")
    ));

    const intento = interpretar(
      await crear.execute({ caso, payload: {}, confirmado: true }, ctx)
    );
    assert.equal(intento.ok, false);
    console.log(caso, "BLOQUEADA", JSON.stringify(resultado));
    continue;
  }

  const construccion = interpretar(
    await construir_payload.execute({
      caso,
      paquete: lectura.data,
      derivados: resultado.derivados,
    }, ctx)
  );
  assert.equal(construccion.ok, true);

  const { payload } = construccion.data as { payload: unknown };

  const evidencia = interpretar(
    await generar_evidencia.execute({ caso }, ctx)
  );
  assert.equal(evidencia.ok, true);

  if (resultado.confirmaciones.length) {
    // El booleano del modelo por sí solo no debe autorizar la creación.
    const sinPermiso = interpretar(
      await crear.execute({ caso, payload, confirmado: true }, ctx)
    );
    assert.equal(sinPermiso.ok, false);

    console.log(caso, "PENDIENTE", JSON.stringify(resultado));

    // Acción humana simulada explícitamente por el demo.
    assert.equal(confirmarPendiente(ctx.sessionId), caso);
  }

  const creada = interpretar(
    await crear.execute({ caso, payload, confirmado: true }, ctx)
  );
  assert.equal(creada.ok, true);
  console.log(caso, "CREADA", JSON.stringify(creada.data));

  if (numero === 1) {
    const repetida = interpretar(
      await crear.execute({ caso, payload }, ctx)
    );
    assert.equal(repetida.ok, true);

    const primera = creada.data as { numero_oc: string };
    const segunda = repetida.data as {
      numero_oc: string;
      idempotente: boolean;
    };

    assert.equal(primera.numero_oc, "4500000001");
    assert.equal(segunda.numero_oc, primera.numero_oc);
    assert.equal(segunda.idempotente, true);
    console.log("✅ sol-001 repetida sin duplicados");
  }
}

console.log("✅ Seis casos, confirmaciones y creación verificados sin LLM");