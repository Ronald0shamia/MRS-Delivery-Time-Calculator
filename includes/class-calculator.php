<?php
defined('ABSPATH') || exit;

class MRS_DTC_Calculator {
    /**
     * Berechnete Zustellzeit = Hauszeit + Gehzeit (Strecke / Gehgeschwindigkeit) + zusätzliche Zeit.
     * Die Routing-Dauer des Routing-Dienstes fließt bewusst NICHT ein, sie wird nur separat gespeichert.
     */
    public static function calculate(array $addresses, float $distance_meters, float $speed_kmh, float $additional_minutes): array {
        $house_seconds = 0;
        foreach ($addresses as $address) {
            $house_seconds += max(0, (int) ($address['seconds'] ?? 0));
        }

        $walking_seconds = $speed_kmh > 0 ? (int) round(($distance_meters / 1000) / $speed_kmh * 3600) : 0;
        $additional_seconds = (int) round(max(0, $additional_minutes) * 60);

        return [
            'house_seconds'            => $house_seconds,
            'walking_seconds'          => $walking_seconds,
            'additional_seconds'       => $additional_seconds,
            'calculated_total_seconds' => $house_seconds + $walking_seconds + $additional_seconds,
        ];
    }

    public static function format_seconds(int $seconds): string {
        $seconds = max(0, $seconds);
        $hours = intdiv($seconds, 3600);
        $minutes = intdiv($seconds % 3600, 60);
        $secs = $seconds % 60;
        return sprintf('%02d:%02d:%02d', $hours, $minutes, $secs);
    }
}
