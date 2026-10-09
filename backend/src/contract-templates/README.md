# Plantillas de contratos internos

Texto de trabajo pendiente de revisión jurídica. No contiene datos de una cuenta
real. El servidor sustituye los marcadores en MAYÚSCULAS por una foto del
expediente y de Ajustes de la cuenta.

Para modificar la redacción, edita el archivo .txt y aumenta el entero del archivo
.version correspondiente en el mismo cambio. La compilación copia ambos a dist.
La nueva redacción solo se usa en contratos nuevos o borradores que se envían:
ningún contrato firmado se recalcula.

Los días de vigencia/renovación del paquete y de aviso de baja provienen del
backend. No agregues precios ni cantidades fijas en la plantilla. Un marcador
desconocido impide generar el documento. Usa el endpoint de vista previa antes
de enviar y revisa tanto PDF como texto.

La firma por aceptación no es una firma criptográfica certificada. Se guarda
la evidencia (nombre, fecha/hora, IP, navegador y hash del PDF) y el documento
firmado queda inmutable. El escaneo firmado en papel usa el mismo archivo
privado del expediente.
