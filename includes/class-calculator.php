<?php
defined('ABSPATH') || exit;

class MRS_DTC_Calculator {
    public static function calculate(array $addresses, int $route_duration, int $additional_minutes): array {
        $house_seconds = 0;
        foreach ($addresses as $address) {
            $house_seconds += max(0, (int) ($address['seconds'] ?? 0));
        }

        $additional_seconds = max(0, $additional_minutes) * 60;
        $total = $house_seconds + max(0, $route_duration) + $additional_seconds;

        return [
            'house_seconds' => $house_seconds,
            'route_duration_seconds' => max(0, $route_duration),
            'additional_seconds' => $additional_seconds,
            'calculated_total_seconds' => $total,
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
