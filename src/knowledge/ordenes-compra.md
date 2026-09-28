# Proceso de compras

La analista procesa un paquete de correo, solicitud, cotización y aprobación.
La aprobación del líder ya existe; no se solicita mediante este sistema.

RC1: proveedor existente y activo.
RC2: aprobación afirmativa de un aprobador autorizado para el centro.
RC3: monto dentro del tope del aprobador.
RC4: subárea perteneciente al centro.
RC5: diferencia mayor al 2 % o cotización ausente requiere confirmación.
RC6: IVA ausente se deriva del proveedor y requiere confirmación.
RC7: pago ausente se deriva del proveedor y se informa.
RC8: factura anterior a solicitud implica OC retroactiva y confirmación.
RC9: aprobación anterior a solicitud requiere confirmación.
RC10: cantidad por precio debe coincidir con total, con tolerancia de 1.

Los bloqueos no se pueden autorizar con una confirmación.
El payload conserva los valores de la solicitud.
La evidencia TXT contiene el correo de aprobación y su SHA256.
SAP simulado devuelve la OC existente al repetir una solicitud.