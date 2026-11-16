<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class SendConsoleCommandRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            // Una sola riga: niente caratteri di controllo (a capo, escape, …)
            'command' => ['required', 'string', 'max:500', 'regex:/^[^\x00-\x1F\x7F]+$/u'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return ['command.regex' => 'Il comando deve stare su una riga e non può contenere caratteri di controllo.'];
    }

    /**
     * Comandi di tModLoader che spengono il server: equivalgono a uno "stop".
     */
    public function shutsDownServer(): bool
    {
        return in_array(strtolower(strtok(trim($this->validated('command')), ' ')), ['exit', 'exit-nosave'], true);
    }
}
