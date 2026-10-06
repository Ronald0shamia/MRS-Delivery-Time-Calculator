=== MRS Delivery Time Calculator ===
Contributors: mrs-dev
Tags: delivery, route, openstreetmap, leaflet, nominatim, osrm
Requires at least: 6.0
Requires PHP: 8.1
Stable tag: 1.3.0
License: GPLv2 or later

== Description ==
Berechnet und dokumentiert Zeitung-Zustelltouren mit OpenStreetMap, Nominatim und OSRM.

== Shortcode ==
[mrs_delivery_time_calculator]

== External Services ==
Dieses Plugin nutzt:
* OpenStreetMap-Kacheln für die Kartenanzeige (der Browser lädt sie von tile.openstreetmap.org).
* Nominatim für die Adresssuche.
* OSRM für die Routenberechnung.

Die externen Dienste können IP-Adressen und Anfrageinformationen nach ihren jeweiligen Richtlinien verarbeiten. Bitte beachte die jeweiligen Nutzungsbedingungen und Datenschutzbestimmungen.

== Installation ==
1. Plugin-ZIP hochladen.
2. Plugin aktivieren.
3. Eine Seite mit [mrs_delivery_time_calculator] erstellen.
4. Unter Delivery Time > Einstellungen die Standardwerte prüfen.

== Changelog ==
= 1.3.0 =
* Route wahlweise zu Fuß, mit dem Fahrrad oder mit dem Auto (drei Icon-Buttons).
* Eigene Durchschnittsgeschwindigkeit und Routing-URL pro Verkehrsmittel in den Einstellungen.
* Verkehrsmittel wird mit jeder Berechnung gespeichert und im Dashboard angezeigt.

= 1.2.0 =
* Gespeicherte Berechnungen werden nur noch im Dashboard angezeigt (nicht mehr im Frontend).
* Adressen lassen sich per Drag & Drop (Maus und Touch) umsortieren; die Pfeil-Buttons bleiben.

= 1.1.0 =
* REST-Endpunkte nur für angemeldete Benutzer; eigene Berechnungen pro Benutzer.
* Gehzeit aus Strecke und Gehgeschwindigkeit; Routing-Dauer separat.
* Leaflet lokal gebündelt, Route automatisch, Speichern/Öffnen/Bearbeiten/Löschen.
* Nominatim: Cache, Drosselung, Länderfilter, verständliche Fehlermeldungen.
* Speichern in einer Transaktion; Routen bis 300 Adressen.

= 1.0.0 =
* Erste Version.
