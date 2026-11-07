export function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null)
            continue;
        if (key === 'class')
            element.className = value;
        else if (key === 'text')
            element.textContent = value;
        else if (key === 'html')
            element.innerHTML = value;
        else if (key === 'dataset') {
            for (const [name, data] of Object.entries(value))
                element.dataset[name] = data;
        } else if (key.startsWith('on') && typeof value === 'function')
            element.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in element)
            element[key] = value;
        else
            element.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false)
            continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
}

export function icon(provider) {
    return h('img', {
        src: `/icons/provider-${provider}-symbolic.svg`,
        alt: '',
        loading: 'lazy',
    });
}

// One stroke icon set (24px grid, 1.8px stroke) so every glyph in the page
// shares a visual language.  The markup is static, never user data.
const UI_ICONS = {
    providers: '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    layout: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
    appearance: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.9.7-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.3 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/><circle cx="17" cy="11" r="1"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    reload: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    power: '<path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    hidden: '<path d="m3 3 18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.1A10 10 0 0 1 12 5c5 0 9 5 10 7a17 17 0 0 1-2.6 3.4"/><path d="M6.6 6.6C4.6 8 3.2 10.1 2 12c1 2 5 7 10 7 1.8 0 3.4-.5 4.8-1.3"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
    move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    resize: '<path d="M8 12h8"/><path d="m5 9-3 3 3 3M19 9l3 3-3 3"/>',
    terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
    lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

export function uiIcon(name, className = '') {
    const span = h('span', {class: `ui-icon ${className}`.trim(), 'aria-hidden': 'true'});
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] ?? ''}</svg>`;
    return span;
}

export function panel(title, subtitle, ...contents) {
    const head = title
        ? h('div', {class: 'panel-head'},
            h('div', {},
                h('h2', {class: 'panel-title', text: title}),
                subtitle ? h('p', {class: 'panel-sub', text: subtitle}) : null))
        : null;
    return h('section', {class: 'panel'}, head, ...contents);
}

let rowSequence = 0;

export function row(title, description, control) {
    const titleId = `row-title-${++rowSequence}`;
    const descId = `row-desc-${rowSequence}`;
    const element = h('div', {class: 'row'},
        h('div', {class: 'row-copy'},
            h('div', {class: 'row-title', id: titleId, text: title}),
            description ? h('div', {class: 'row-desc', id: descId, text: description}) : null),
        control ? h('div', {class: 'row-control'}, control) : null);
    if (control) {
        // Name the control from its visible row title so screen readers and
        // click-to-label both work without visible <label> elements.
        const nodes = control.matches?.('input, select, button')
            ? [control]
            : [...(control.querySelectorAll?.('input, select, button') ?? [])];
        for (const node of nodes) {
            node.setAttribute('aria-labelledby', titleId);
            if (description)
                node.setAttribute('aria-describedby', descId);
        }
    }
    return element;
}

export function switchControl(checked, onChange, label = '', {disabled = false, title = ''} = {}) {
    const input = h('input', {type: 'checkbox', role: 'switch', checked: Boolean(checked), disabled, title: title || null});
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', {class: 'switch'}, input, label ? h('span', {text: label}) : null);
}

export function numberControl(value, {min = 0, max = 100, step = 1, onChange} = {}) {
    const input = h('input', {
        type: 'number',
        value: String(value ?? 0),
        min: String(min),
        max: String(max),
        step: String(step),
    });
    input.addEventListener('change', () => {
        const parsed = Number.parseInt(input.value, 10);
        if (!Number.isFinite(parsed)) {
            input.value = String(value ?? 0);
            return;
        }
        const clamped = Math.max(min, Math.min(max, parsed));
        input.value = String(clamped);
        onChange(clamped);
    });
    return input;
}

/**
 * Slider with a live value read-out.  `onInput` fires while dragging (for
 * previews); `onChange` fires once on release and is what gets saved.
 */
export function rangeControl(value, {min = 0, max = 100, step = 1, unit = '', disabled = false, onInput, onChange} = {}) {
    const input = h('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value ?? min),
        disabled,
    });
    // The read-out is a real field: these sliders set exact pixel and percent
    // values, so typing beats dragging.
    const output = h('input', {
        type: 'number',
        class: 'range-value',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value ?? min),
        disabled,
    });
    const clampValue = raw => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed))
            return Number(input.value);
        return Math.max(min, Math.min(max, Math.round(parsed / step) * step));
    };
    const update = () => {
        input.style.setProperty('--fill', `${(Number(input.value) - min) / Math.max(1, max - min) * 100}%`);
        if (output.value !== input.value)
            output.value = input.value;
    };
    update();
    input.addEventListener('input', () => {
        update();
        onInput?.(Number(input.value));
    });
    input.addEventListener('change', () => onChange?.(Number(input.value)));
    const commit = () => {
        const next = clampValue(output.value);
        if (String(next) === input.value) {
            output.value = input.value;
            return;
        }
        input.value = String(next);
        update();
        onInput?.(next);
        onChange?.(next);
    };
    output.addEventListener('change', commit);
    output.addEventListener('blur', commit);
    output.addEventListener('keydown', event => {
        if (event.key === 'Enter')
            commit();
    });
    return h('div', {class: 'range'}, input, h('span', {class: 'range-value-wrap'}, output, unit ? h('span', {class: 'range-unit', text: unit}) : null));
}

export function segmentedControl(options, value, onChange) {
    const group = h('div', {class: 'segmented', role: 'radiogroup'});
    for (const option of options) {
        const item = h('button', {
            type: 'button',
            class: String(option.value) === String(value) ? 'active' : '',
            text: option.label,
            title: option.title ?? null,
            role: 'radio',
            'aria-checked': String(String(option.value) === String(value)),
        });
        item.addEventListener('click', () => {
            for (const sibling of group.children) {
                sibling.classList.toggle('active', sibling === item);
                sibling.setAttribute('aria-checked', String(sibling === item));
            }
            onChange(option.value);
        });
        group.append(item);
    }
    return group;
}

export function selectControl(options, value, onChange) {
    const select = h('select');
    for (const option of options) {
        const item = h('option', {
            value: String(option.value),
            text: option.label,
        });
        item.selected = String(option.value) === String(value);
        select.append(item);
    }
    select.addEventListener('change', () => onChange(select.value));
    return h('span', {class: 'select-wrap'}, select, uiIcon('chevron'));
}

export function button(label, {onClick, className = 'button', type = 'button', disabled = false, iconName = '', title = ''} = {}) {
    const element = h('button', {class: className, type, disabled, title: title || null});
    if (!label && title)
        element.setAttribute('aria-label', title);
    if (iconName)
        element.append(uiIcon(iconName));
    if (label)
        element.append(h('span', {text: label}));
    if (onClick)
        element.addEventListener('click', onClick);
    return element;
}

export function statusPill(text, tone = '') {
    return h('span', {class: `pill ${tone}`.trim(), text});
}

export function errorBox(message, retry) {
    const box = h('div', {class: 'error-box'},
        h('div', {text: message}),
        retry ? h('div', {style: 'margin-top:10px;'},
            button('Retry', {onClick: retry})) : null);
    return box;
}
