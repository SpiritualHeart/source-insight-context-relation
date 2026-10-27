#ifndef APP_MODEL_H
#define APP_MODEL_H

typedef unsigned char UINT8;
typedef unsigned char BOOL;

#define FALSE 0u
#define TRUE  1u

typedef struct
{
    UINT8 state;
    BOOL enabled;
} APP_ModelState_t;

extern UINT8 g_app_model_state;
extern APP_ModelState_t g_app_model;

void APP_Model_Set29COutputs(void);
void APP_Model_SetPEPsOutputs(void);
void APP_Model_Task10ms(void);
void APP_Model_Init(void);

#endif /* APP_MODEL_H */
