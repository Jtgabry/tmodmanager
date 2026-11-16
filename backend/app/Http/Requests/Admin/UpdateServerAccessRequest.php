<?php

namespace App\Http\Requests\Admin;

use App\Enums\ServerAbility;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateServerAccessRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'abilities' => ['present', 'array'],
            'abilities.*' => ['distinct', Rule::enum(ServerAbility::class)],
        ];
    }
}
