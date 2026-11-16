<?php

namespace App\Services\Agent;

/**
 * Operazioni di accensione supportate dall'agent (POST /servers/{id}/{action}).
 */
enum ServerPowerAction: string
{
    case Start = 'start';
    case Stop = 'stop';
    case Restart = 'restart';
}
