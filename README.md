# Escena

Reproductor profesional de secuencias multitrack para músicos, bandas, iglesias y técnicos de sonido.

- Mezclador por pista: volumen, paneo, mute y solo.
- Click con mapa de tempo y pre-conteo.
- Guías de voz por secciones (Intro, Verso, Coro, Puente…) que avisan antes de cada cambio.
- Editor de secciones sobre la onda de la canción: zoom hasta ver cada golpe, compases dibujados como bloques y marcadores que se arrastran al compás exacto. Al tocar la onda se elige siempre un compás completo, y si la canción suena el salto espera al final del compás (o del tiempo, según el ajuste de salto). La canción no se detiene mientras editas y los cambios de tempo, click y guía se oyen al instante.
- Salida estéreo dividida: click y guía por el canal izquierdo, pistas por el derecho (se puede invertir).
- Salidas múltiples: con una interfaz de audio de varias salidas, eliges por cuáles suenan las pistas (por ejemplo la 1 y la 2) y por cuál el click y la guía (por ejemplo la 3). Si desconectas la interfaz y la vuelves a conectar, la app la recupera sola.
- Setlist, modo escenario y control con pedal Bluetooth, teclado o MIDI.
- Funciona sin internet una vez instalada. Tus canciones se quedan en tu dispositivo y no se suben a ningún servidor.

## Descargas

Entra a [Descargas (Releases)](../../releases/latest) y baja el archivo de tu dispositivo. También las encuentras en la columna derecha de esta página, en **Releases**.

| Dispositivo | Archivo | Cómo instalar |
| --- | --- | --- |
| Android | `Escena-Android-…apk` | Descárgalo en el celular o la tablet, ábrelo e instálalo. Si el teléfono lo pide, permite instalar apps desde esa fuente. |
| Windows | `Escena-Instalador-…exe` o `Escena-Portatil-…exe` | El instalador deja la app en el menú Inicio; la versión portátil funciona sin instalar. Si aparece «Windows protegió su PC», pulsa **Más información** y luego **Ejecutar de todas formas**. |
| Mac | `Escena-Mac-…dmg` | Abre el archivo y arrastra Escena a Aplicaciones. La primera vez macOS la bloquea: ve a Configuración del Sistema, Privacidad y seguridad, y pulsa **Abrir de todos modos**. |
| iPhone, iPad y navegadores | Versión web | La dirección está en las notas de cada versión. En Safari pulsa Compartir y luego **Añadir a pantalla de inicio**. |

## Primeros pasos

1. Abre la app y pulsa **Crear canción de prueba**: genera una canción de cuatro pistas con click y guía de voz para que pruebes todo sin archivos propios.
2. Para usar tus canciones pulsa **Importar canciones** y elige una pista por archivo (WAV, MP3, FLAC, M4A, OGG, AIFF) o un ZIP con todas las pistas. Todas deben empezar en el mismo punto.
3. Las pistas que se llamen «Click» o «Guía», «Cue» o «Conteo» van a la salida Cue (músicos); las demás van a Sala (público). Si hay una pista de click, el tempo se detecta solo.
4. Entra a **Editar canción** para revisar el tempo, colocar las secciones sobre la onda con zoom (con su guía de voz) y ajustar el destino de cada pista. La reproducción sigue mientras editas. Toca un compás de la onda para elegirlo y pulsa el nombre de una sección (Intro, Verso, Coro…) para marcarlo exactamente ahí.
5. Arma tu setlist y usa el **Modo escenario** durante el servicio o el concierto.

## Compilación automática

Cada vez que se suben cambios a este repositorio, GitHub prepara solo la página web, el APK de Android, el instalador de Windows y el DMG de Mac, y los publica como una nueva versión en **Releases**.

Para compilar sin cambiar nada: **Actions**, luego **Construir Escena**, **Run workflow**. Editar solamente archivos de texto con extensión .md, como este, no inicia una compilación.

© ingvelarde.com. Todos los derechos reservados.
